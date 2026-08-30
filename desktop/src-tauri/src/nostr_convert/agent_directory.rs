//! Conversion and verification for relay-discovered agents.

use std::collections::{BTreeSet, HashMap};

use nostr::Event;

use crate::managed_agents::{
    agent_events::managed_agent_content_from_event, RelayAgentInfo, RespondTo,
};

use super::{agents_from_events, first_tag_value, profile_valid_oa_owner_pubkey, tags_named};

/// Collect valid agent pubkeys from kind:30177 `d` tags for follow-up relay
/// queries. Malformed tags are ignored so one hostile event cannot invalidate
/// the whole directory request.
pub fn managed_agent_pubkeys_from_events(events: &[Event]) -> std::collections::HashSet<String> {
    events
        .iter()
        .filter_map(|event| first_tag_value(event, "d"))
        .filter_map(|pubkey| nostr::PublicKey::from_hex(pubkey).ok())
        .map(|pubkey| pubkey.to_hex())
        .collect()
}

fn event_is_newer(candidate: &Event, previous: &Event) -> bool {
    candidate.created_at > previous.created_at
        || (candidate.created_at == previous.created_at && candidate.id < previous.id)
}

/// The latest kind:0 profile per author.
fn latest_profiles_by_author(profile_events: &[Event]) -> HashMap<String, &Event> {
    let mut latest: HashMap<String, &Event> = HashMap::new();
    for profile in profile_events {
        let author = profile.pubkey.to_hex();
        if latest
            .get(&author)
            .is_none_or(|previous| event_is_newer(profile, previous))
        {
            latest.insert(author, profile);
        }
    }
    latest
}

/// Names agents published about themselves, from their kind:0 profiles.
///
/// A kind:10100 directory entry routinely carries no name at all — on a live
/// relay its content is as thin as `{"channel_add_policy":"anyone"}` — while
/// the name people actually type (`cid`, `intake`) lives on the agent's kind:0
/// profile. Both are self-authored and already fetched together.
fn profile_display_names(profile_events: &[Event]) -> HashMap<String, String> {
    latest_profiles_by_author(profile_events)
        .into_iter()
        .filter_map(|(author, profile)| {
            let content: serde_json::Value = serde_json::from_str(&profile.content).ok()?;
            let name = ["display_name", "name"]
                .iter()
                .find_map(|key| content.get(*key).and_then(serde_json::Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            Some((author, name.to_string()))
        })
        .collect()
}

/// Whether a directory entry named itself, as opposed to being given the npub
/// fallback `agents_from_events` synthesizes for an entry with no name.
fn entry_names_itself(event: &Event) -> bool {
    let Ok(content) = serde_json::from_str::<serde_json::Value>(&event.content) else {
        return false;
    };
    ["name", "display_name"].iter().any(|key| {
        content
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn relay_agents_from_legacy_events(
    events: &[Event],
    profile_events: &[Event],
) -> Vec<RelayAgentInfo> {
    let verified_owners = verified_agent_owners_from_profiles(profile_events);
    let profile_names = profile_display_names(profile_events);
    let mut latest: HashMap<String, &Event> = HashMap::new();
    for event in events {
        let pubkey = event.pubkey.to_hex();
        if latest
            .get(&pubkey)
            .is_none_or(|previous| event_is_newer(event, previous))
        {
            latest.insert(pubkey, event);
        }
    }

    latest
        .into_values()
        .filter_map(|event| {
            let value = agents_from_events(std::slice::from_ref(event));
            let mut agent: RelayAgentInfo =
                serde_json::from_value(value.get("agents")?.as_array()?.first()?.clone()).ok()?;
            // The owner cryptographically attested by NIP-OA on the agent's
            // own kind:0 profile — the same check the managed path uses. This
            // was previously forced to `None` so a legacy record could not
            // drive the live 30177 watcher; no such watcher reads this field,
            // and nulling it costs the agent its mentions outright:
            // `relayAgentIsSharedWithUser` can only admit an `owner-only`
            // agent when the owner is known, so the one person allowed to
            // mention it was locked out. A marked build goes further and drops
            // an ownerless record entirely (`retain_agents_allowed_by_build`),
            // which is only coherent if a legacy entry CAN carry an owner.
            agent.owner_pubkey = verified_owners.get(&agent.pubkey).cloned();
            // `agents_from_events` falls back to an npub when the entry names
            // nothing. That is not a harmless placeholder: the composer ranks
            // this name above the profile's display name, so the npub wins and
            // there is nothing left to type.
            if !entry_names_itself(event) {
                if let Some(name) = profile_names.get(&agent.pubkey) {
                    agent.name = name.clone();
                }
            }
            // `relay_agent_is_shared_with_user` matches owner-only, allowlist
            // and anyone explicitly and denies anything else, so an unset
            // policy is silently a denial. `RespondTo::default()` is
            // `OwnerOnly` — what the agent's own harness applies to an unset
            // field — so the UI offers exactly what the agent would honour.
            agent.respond_to = agent.respond_to.or(Some(RespondTo::default()));
            // Channel membership is authoritative only in relay-signed kind:39002.
            agent.channel_ids.clear();
            Some(agent)
        })
        .collect()
}

/// Merge self-authored kind:10100 runtime profiles with verified Desktop-managed
/// policy records. A verified managed coordinate reserves the agent identity even
/// when its current policy is malformed, so stale legacy permissions cannot win.
pub fn relay_agents_from_directory_events(
    directory_events: &[Event],
    managed_agent_events: &[Event],
    profile_events: &[Event],
) -> Vec<RelayAgentInfo> {
    let verified_policies = latest_verified_managed_policies(managed_agent_events, profile_events);
    let mut agents: HashMap<String, RelayAgentInfo> =
        relay_agents_from_legacy_events(directory_events, profile_events)
            .into_iter()
            .map(|agent| (agent.pubkey.clone(), agent))
            .collect();
    for agent_pubkey in verified_policies.keys() {
        agents.remove(agent_pubkey);
    }
    for (agent_pubkey, event) in verified_policies {
        if let Some(agent) = relay_agent_from_managed_policy(&agent_pubkey, event) {
            agents.insert(agent_pubkey, agent);
        }
    }

    let mut agents: Vec<_> = agents.into_values().collect();
    agents.sort_by(|left, right| left.name.cmp(&right.name));
    agents
}

/// Resolve each agent's owner from its latest signed NIP-OA profile.
pub fn verified_agent_owners_from_profiles(events: &[Event]) -> HashMap<String, String> {
    latest_profiles_by_author(events)
        .into_iter()
        .filter_map(|(agent_pubkey, profile)| {
            profile_valid_oa_owner_pubkey(profile).map(|owner| (agent_pubkey, owner))
        })
        .collect()
}

fn latest_verified_managed_policies<'a>(
    managed_agent_events: &'a [Event],
    profile_events: &[Event],
) -> HashMap<String, &'a Event> {
    let verified_owners = verified_agent_owners_from_profiles(profile_events);

    let mut latest: HashMap<String, &'a Event> = HashMap::new();
    for event in managed_agent_events {
        let Some(agent_pubkey) = first_tag_value(event, "d") else {
            continue;
        };
        if verified_owners.get(agent_pubkey) != Some(&event.pubkey.to_hex()) {
            continue;
        }
        if latest
            .get(agent_pubkey)
            .is_none_or(|previous| event_is_newer(event, previous))
        {
            latest.insert(agent_pubkey.to_string(), event);
        }
    }
    latest
}

fn relay_agent_from_managed_policy(agent_pubkey: &str, event: &Event) -> Option<RelayAgentInfo> {
    let content = managed_agent_content_from_event(event).ok()?;
    Some(RelayAgentInfo {
        pubkey: agent_pubkey.to_string(),
        owner_pubkey: Some(event.pubkey.to_hex()),
        name: content.name,
        agent_type: "agent".to_string(),
        channels: Vec::new(),
        channel_ids: Vec::new(),
        capabilities: Vec::new(),
        status: "offline".to_string(),
        respond_to: Some(content.respond_to),
        respond_to_allowlist: content.respond_to_allowlist,
    })
}

/// Build the relay agent directory from owner-authenticated managed-agent
/// records. A kind:30177 event is accepted only when its author matches the
/// owner cryptographically declared by the agent's latest kind:0 NIP-OA tag.
pub fn relay_agents_from_managed_agent_events(
    managed_agent_events: &[Event],
    profile_events: &[Event],
) -> Vec<RelayAgentInfo> {
    let mut agents: Vec<_> = latest_verified_managed_policies(managed_agent_events, profile_events)
        .into_iter()
        .filter_map(|(agent_pubkey, event)| relay_agent_from_managed_policy(&agent_pubkey, event))
        .collect();
    agents.sort_by(|left, right| left.name.cmp(&right.name));
    agents
}

/// Build a pubkey-to-channel-id candidate map from relay-signed membership
/// events. Only p-tags explicitly marked with the `bot` role are agents.
pub fn member_agent_channel_ids_from_events(
    events: &[Event],
    relay_pubkey: &str,
) -> HashMap<String, Vec<String>> {
    let mut channel_ids: HashMap<String, BTreeSet<String>> = HashMap::new();
    for event in events {
        if !event.pubkey.to_hex().eq_ignore_ascii_case(relay_pubkey) {
            continue;
        }
        let Some(channel_id) = first_tag_value(event, "d") else {
            continue;
        };
        for tag in tags_named(event, "p") {
            let (Some(pubkey), Some(role)) = (tag.get(1), tag.get(3)) else {
                continue;
            };
            if role != "bot" || nostr::PublicKey::from_hex(pubkey).is_err() {
                continue;
            }
            channel_ids
                .entry(pubkey.clone())
                .or_default()
                .insert(channel_id.to_string());
        }
    }

    channel_ids
        .into_iter()
        .map(|(pubkey, ids)| (pubkey, ids.into_iter().collect()))
        .collect()
}
