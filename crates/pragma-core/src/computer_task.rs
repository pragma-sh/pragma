//! Pure task rules: deterministic text extraction, screen fingerprints and validated choices.
use pragma_constants::{
    ComputerDecideRequest, ComputerDecision, ComputerDecisionKind, ComputerSnapshot, CONSTANTS,
};
use std::collections::{hash_map::DefaultHasher, BTreeMap};
use std::hash::{Hash, Hasher};

/// Extract only literal caller text. Nothing here generates prose.
#[must_use]
pub fn extract_variables(instruction: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    // Quoted values retain their exact bytes, including non-ASCII characters.
    for (index, value) in instruction.split('"').skip(1).step_by(2).enumerate() {
        if !value.is_empty() {
            result.insert(format!("quoted_{}", index + 1), value.to_string());
        }
    }
    for word in instruction.split_whitespace() {
        let word = word.trim_matches(|c: char| matches!(c, ',' | ';' | '(' | ')' | '"' | '\''));
        if word.starts_with("https://") || word.starts_with("http://") {
            result
                .entry("url".to_string())
                .or_insert_with(|| word.to_string());
        } else if word.contains('@') && word.contains('.') {
            result
                .entry("email".to_string())
                .or_insert_with(|| word.to_string());
        } else if word.starts_with('/') || word.starts_with("~/") || word.contains(":\\") {
            result
                .entry("path".to_string())
                .or_insert_with(|| word.to_string());
        }
    }
    result
}

/// Address fields are observed data; only absolute HTTP(S) URLs are accepted.
#[must_use]
pub fn observed_url(elements: &[pragma_constants::ComputerElement]) -> Option<String> {
    elements
        .iter()
        .filter(|e| e.editable && !e.secure)
        .find_map(|e| {
            let label =
                format!("{} {}", e.label, e.identifier.as_deref().unwrap_or("")).to_lowercase();
            e.value
                .as_ref()
                .filter(|v| {
                    (label.contains("address")
                        || label.contains("url")
                        || label.contains("location"))
                        && (v.starts_with("https://") || v.starts_with("http://"))
                })
                .cloned()
        })
}
/// Exact URL authority matching for deterministic navigation postconditions.
#[must_use]
pub fn url_host(value: &str) -> Option<String> {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some(authority.to_ascii_lowercase())
}

/// Fingerprint UI semantics, excluding ephemeral snapshot ids and timestamps.
#[must_use]
pub fn screen_hash(snapshot: &ComputerSnapshot) -> String {
    let mut hash = DefaultHasher::new();
    snapshot.app.id.hash(&mut hash);
    snapshot.url.hash(&mut hash);
    for e in &snapshot.elements {
        (&e.key, &e.role, &e.label, &e.value, e.focused, e.enabled).hash(&mut hash);
        if let Some(frame) = &e.frame {
            for value in [frame.x, frame.y, frame.w, frame.h] {
                value.round().to_bits().hash(&mut hash);
            }
        }
    }
    format!("{:016x}", hash.finish())
}

/// Reject unoffered model values and uncertain choices before any native action.
pub fn validate_decision(
    request: &ComputerDecideRequest,
    decision: &ComputerDecision,
) -> Result<(), &'static str> {
    // Asking the caller for text has no native effect; uncertainty should hand
    // control back to them rather than turn an input request into a failure.
    if decision.kind == ComputerDecisionKind::RequestText {
        return Ok(());
    }
    if !probability(decision.confidence) || decision.confidence < CONSTANTS.computer.next_confidence
    {
        return Err("lowConfidence");
    }
    match decision.kind {
        ComputerDecisionKind::ClickItem | ComputerDecisionKind::TypeVariable => {
            let element = request
                .snapshot
                .elements
                .iter()
                .find(|e| Some(&e.id) == decision.item.as_ref());
            let Some(element) = element.filter(|e| e.enabled && !e.secure) else {
                return Err("ambiguousTarget");
            };
            if decision
                .item_confidence
                .is_none_or(|p| !probability(p) || p < CONSTANTS.computer.item_confidence)
                || decision
                    .item_margin
                    .is_none_or(|p| !probability(p) || p < CONSTANTS.computer.item_margin)
            {
                return Err("ambiguousTarget");
            }
            if decision.kind == ComputerDecisionKind::TypeVariable
                && (!element.editable
                    || !decision
                        .variable
                        .as_ref()
                        .is_some_and(|v| request.variables.contains(v)))
            {
                return Err("missingInput");
            }
        }
        ComputerDecisionKind::PressKey
            if !decision
                .key
                .as_ref()
                .is_some_and(|key| CONSTANTS.computer.task_keys.contains(key)) =>
        {
            return Err("invalidDecision")
        }
        ComputerDecisionKind::SwitchApp
            if !decision
                .app
                .as_ref()
                .is_some_and(|app| request.apps.iter().any(|a| &a.id == app)) =>
        {
            return Err("invalidDecision")
        }
        ComputerDecisionKind::Done
            if !probability(decision.achieved)
                || decision.achieved < CONSTANTS.computer.achieved_confidence =>
        {
            return Err("lowConfidence")
        }
        _ => {}
    }
    Ok(())
}

fn probability(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_values_keep_unicode_and_do_not_generate_text() {
        let vars = extract_variables("Type \"héllo\" and open https://example.com");
        assert_eq!(vars.get("quoted_1").map(String::as_str), Some("héllo"));
        assert_eq!(
            vars.get("url").map(String::as_str),
            Some("https://example.com")
        );
        assert!(extract_variables("write a good repository name").is_empty());
    }

    fn request() -> ComputerDecideRequest {
        serde_json::from_value(serde_json::json!({
            "instruction":"click Save", "apps":[], "variables":["text"], "history":[], "tried":[],
            "snapshot": {"id":"s1", "app":{"id":"app:test", "name":"Test", "running":true, "frontmost":true},
                "elements":[{"id":"s1:e1", "key":"save", "role":"button", "label":"Save",
                    "enabled":true,"focused":false,"editable":false,"secure":false,"actions":["press"],
                    "onScreen":true,"path":[0],"depth":0,"frame":{"x":10,"y":10,"w":100,"h":30}}],
                "truncated":false,"nodeCount":1,"elapsedMs":0,"createdAt":0,"untrusted":true}
        })).unwrap()
    }

    #[test]
    fn decisions_reject_unoffered_secure_and_uncertain_targets() {
        let mut request = request();
        let mut decision: ComputerDecision = serde_json::from_value(serde_json::json!({
            "kind":"click_item","item":"s1:e1","confidence":0.9,"itemConfidence":0.9,
            "itemMargin":0.3,"achieved":0.0
        }))
        .unwrap();
        assert_eq!(validate_decision(&request, &decision), Ok(()));
        decision.item = Some("unoffered".into());
        assert_eq!(
            validate_decision(&request, &decision),
            Err("ambiguousTarget")
        );
        decision.item = Some("s1:e1".into());
        decision.item_margin = Some(0.01);
        assert_eq!(
            validate_decision(&request, &decision),
            Err("ambiguousTarget")
        );
        decision.item_margin = Some(0.3);
        request.snapshot.elements[0].secure = true;
        assert_eq!(
            validate_decision(&request, &decision),
            Err("ambiguousTarget")
        );
        decision.confidence = 1.1;
        assert_eq!(validate_decision(&request, &decision), Err("lowConfidence"));
    }

    #[test]
    fn screen_hash_ignores_snapshot_ids_but_tracks_layout_and_values() {
        let snapshot = request().snapshot;
        let original = screen_hash(&snapshot);
        let mut changed = snapshot.clone();
        changed.id = "s2".into();
        changed.elements[0].id = "s2:e1".into();
        assert_eq!(screen_hash(&changed), original);
        changed.elements[0].frame.as_mut().unwrap().x += 20.0;
        assert_ne!(screen_hash(&changed), original);
        changed = snapshot;
        changed.elements[0].value = Some("updated".into());
        assert_ne!(screen_hash(&changed), original);
    }

    #[test]
    fn uncertain_text_requests_hand_back_to_the_caller_without_acting() {
        let request = request();
        let mut decision: ComputerDecision = serde_json::from_value(serde_json::json!({
            "kind":"request_text","confidence":0.0,"achieved":0.0
        }))
        .unwrap();
        assert_eq!(validate_decision(&request, &decision), Ok(()));
        decision.kind = ComputerDecisionKind::ClickItem;
        assert_eq!(validate_decision(&request, &decision), Err("lowConfidence"));
    }
}
