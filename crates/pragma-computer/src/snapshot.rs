//! Platform-neutral snapshot building: role normalisation, labels, pruning,
//! and the ring of recent snapshots that element ids resolve against.
//!
//! Each backend walks its own accessibility tree and hands every node here as
//! a [`RawNode`]. The pruning rules are the lessons from earlier computer-use
//! work on this machine: accessibility frames lie, tiny and nameless nodes are
//! noise, and closed menus and off-display subtrees only confuse a caller.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use pragma_constants::{ComputerElement, ComputerErrorCode, ComputerRect, CONSTANTS};
use pragma_core::computer::{element_id, element_key, parse_element_id, truncate_label};

use crate::{failure, ComputerResult};

/// One accessibility node as a backend read it, before pruning.
// The flags mirror independent accessibility attributes one for one; folding
// them into enums would only rename what the platform already reports.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Default)]
pub struct RawNode {
    /// The platform's role (`AXButton`, `Button`, …).
    pub role: String,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub value: Option<String>,
    pub placeholder: Option<String>,
    pub identifier: Option<String>,
    pub frame: Option<ComputerRect>,
    pub enabled: bool,
    pub focused: bool,
    pub editable: bool,
    pub secure: bool,
    /// The platform explicitly reports this element as offscreen.
    pub offscreen: bool,
    pub actions: Vec<String>,
    pub path: Vec<u64>,
    pub ancestor_roles: Vec<String>,
}

/// Normalises a platform role to the shared vocabulary.
#[must_use]
pub fn normalize_role(role: &str) -> String {
    let bare = role.strip_prefix("AX").unwrap_or(role);
    let mapped = match bare {
        "Button" | "PopUpButton" | "MenuButton" | "DisclosureTriangle" => "button",
        "CheckBox" => "checkbox",
        "RadioButton" => "radio",
        "TextField" | "SearchField" | "ComboBox" | "Edit" => "textField",
        "TextArea" | "Document" => "textArea",
        "StaticText" | "Text" => "text",
        "Link" | "Hyperlink" => "link",
        "Image" => "image",
        "MenuItem" | "MenuBarItem" => "menuItem",
        "Menu" | "MenuBar" => "menu",
        "Tab" | "TabItem" | "RadioGroup" | "TabGroup" => "tab",
        "Slider" => "slider",
        "Row" | "DataItem" | "ListItem" | "Cell" | "Outline" => "row",
        "Table" | "List" | "Grid" | "DataGrid" | "Tree" => "list",
        "ScrollArea" | "ScrollBar" | "Pane" => "scrollArea",
        "Toolbar" | "ToolBar" => "toolbar",
        "Window" | "Sheet" | "Dialog" | "Drawer" => "window",
        "Group" | "SplitGroup" | "LayoutArea" | "Splitter" | "Custom" => "group",
        "WebArea" => "webArea",
        other => return lower_first(other),
    };
    mapped.to_string()
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The label a person would read for a node.
///
/// Web and Electron content puts it in the description, `AppKit` in the title,
/// and a short value (a static text's content) is the label of last resort.
#[must_use]
pub fn label_of(node: &RawNode) -> String {
    let short_value = node
        .value
        .as_deref()
        .filter(|value| !node.editable && value.chars().count() <= 120);
    [
        node.title.as_deref(),
        node.description.as_deref(),
        short_value,
        node.placeholder.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|text| !text.is_empty())
    .map(truncate_label)
    .unwrap_or_default()
}

/// Limits a walk honours.
#[derive(Debug, Clone)]
pub struct WalkLimits {
    pub max_nodes: usize,
    pub max_depth: usize,
    pub budget: Duration,
    pub include_offscreen: bool,
}

impl WalkLimits {
    /// The shipped limits, narrowed by the caller's request.
    #[must_use]
    pub fn new(max_nodes: Option<u64>, max_depth: Option<u64>, include_offscreen: bool) -> Self {
        let shipped = usize::try_from(CONSTANTS.computer.max_nodes.get()).unwrap_or(4000);
        Self {
            max_nodes: max_nodes
                .and_then(|n| usize::try_from(n).ok())
                .map_or(shipped, |n| n.min(shipped)),
            max_depth: max_depth
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(64),
            budget: Duration::from_millis(CONSTANTS.computer.walk_budget_ms.get()),
            include_offscreen,
        }
    }
}

/// Whether a node is worth offering to a caller.
#[must_use]
pub fn is_interesting(node: &RawNode, label: &str) -> bool {
    let role = normalize_role(&node.role);
    let actionable = !node.actions.is_empty() || node.editable;
    if let Some(frame) = &node.frame {
        let min = CONSTANTS.computer.min_element_points;
        if frame.w < min || frame.h < min {
            return false;
        }
    }
    match role.as_str() {
        // Containers are structure, not targets, unless they carry a name and
        // an action of their own.
        "group" | "scrollArea" | "list" | "toolbar" | "window" | "webArea" | "menu" => {
            actionable && !label.is_empty()
        }
        "text" => !label.is_empty(),
        _ => actionable || !label.is_empty(),
    }
}

/// True when `frame` intersects any of `displays`.
#[must_use]
pub fn on_any_display(frame: &ComputerRect, displays: &[ComputerRect]) -> bool {
    displays.iter().any(|display| {
        frame.x < display.x + display.w
            && frame.x + frame.w > display.x
            && frame.y < display.y + display.h
            && frame.y + frame.h > display.y
    })
}

/// Builds the public element for a kept node.
#[must_use]
pub fn to_element(
    snapshot: u64,
    index: u32,
    node: &RawNode,
    label: String,
    on_screen: bool,
) -> ComputerElement {
    let role = normalize_role(&node.role);
    let ancestors: Vec<&str> = node.ancestor_roles.iter().map(String::as_str).collect();
    ComputerElement {
        id: element_id(snapshot, index),
        key: element_key(&role, node.identifier.as_deref(), &label, &ancestors),
        role,
        subrole: node.subrole.clone(),
        label,
        identifier: node.identifier.clone().filter(|id| !id.is_empty()),
        // Secure values are never read, and long editable values are trimmed
        // like any other untrusted text.
        value: if node.secure {
            None
        } else {
            node.value.as_deref().map(truncate_label)
        },
        enabled: node.enabled,
        focused: node.focused,
        editable: node.editable,
        secure: node.secure,
        actions: node.actions.clone(),
        frame: node.frame.clone(),
        on_screen,
        path: node.path.clone(),
        depth: node.path.len() as u64,
    }
}

/// One stored snapshot: its public elements and the platform handles behind
/// them, in the same order.
pub struct StoredSnapshot<H> {
    pub seq: u64,
    pub pid: u64,
    pub window_id: Option<String>,
    pub elements: Vec<ComputerElement>,
    pub handles: Vec<H>,
    created: Instant,
}

/// The ring of recent snapshots element ids resolve against.
pub struct SnapshotRing<H> {
    next: u64,
    entries: VecDeque<StoredSnapshot<H>>,
    capacity: usize,
    ttl: Duration,
}

impl<H> Default for SnapshotRing<H> {
    fn default() -> Self {
        Self {
            next: 1,
            entries: VecDeque::new(),
            capacity: usize::try_from(CONSTANTS.computer.snapshot_ring_size.get()).unwrap_or(32),
            ttl: Duration::from_millis(CONSTANTS.computer.snapshot_ttl_ms.get()),
        }
    }
}

impl<H> SnapshotRing<H> {
    /// Reserves the next snapshot sequence number.
    pub fn next_seq(&mut self) -> u64 {
        let seq = self.next;
        self.next += 1;
        seq
    }

    /// Stores a snapshot, pushing the oldest one out when the ring is full.
    pub fn insert(
        &mut self,
        seq: u64,
        pid: u64,
        window_id: Option<String>,
        elements: Vec<ComputerElement>,
        handles: Vec<H>,
    ) {
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(StoredSnapshot {
            seq,
            pid,
            window_id,
            elements,
            handles,
            created: Instant::now(),
        });
    }

    /// Resolves an element id to its snapshot entry and index.
    pub fn lookup(&self, id: &str) -> ComputerResult<(&StoredSnapshot<H>, usize)> {
        let reference = parse_element_id(id).ok_or_else(|| {
            failure(
                ComputerErrorCode::InvalidPayload,
                format!("`{id}` is not an element id (expected s<snapshot>:e<index>)"),
            )
        })?;
        let snapshot = self
            .entries
            .iter()
            .find(|entry| entry.seq == reference.snapshot)
            .filter(|entry| entry.created.elapsed() <= self.ttl)
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::SnapshotExpired,
                    format!(
                        "snapshot s{} has expired; run inspect again",
                        reference.snapshot
                    ),
                )
            })?;
        let index = usize::try_from(reference.element).unwrap_or(usize::MAX);
        if index >= snapshot.elements.len() {
            return Err(failure(
                ComputerErrorCode::ElementNotFound,
                format!(
                    "snapshot s{} has no element e{}",
                    reference.snapshot, reference.element
                ),
            ));
        }
        Ok((snapshot, index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w: f64, h: f64) -> ComputerRect {
        ComputerRect {
            x: 0.0,
            y: 0.0,
            w,
            h,
            display_id: None,
        }
    }

    fn button(label: &str) -> RawNode {
        RawNode {
            role: "AXButton".to_string(),
            title: Some(label.to_string()),
            frame: Some(rect(80.0, 24.0)),
            enabled: true,
            actions: vec!["press".to_string()],
            ..RawNode::default()
        }
    }

    #[test]
    fn roles_normalise_across_platforms() {
        assert_eq!(normalize_role("AXButton"), "button");
        assert_eq!(normalize_role("Button"), "button");
        assert_eq!(normalize_role("AXTextField"), "textField");
        assert_eq!(normalize_role("Edit"), "textField");
        assert_eq!(normalize_role("AXUnknownThing"), "unknownThing");
    }

    #[test]
    fn labels_prefer_title_then_description_then_short_value() {
        let mut node = button("Save");
        assert_eq!(label_of(&node), "Save");
        node.title = None;
        node.description = Some("Back".to_string());
        assert_eq!(label_of(&node), "Back");
        node.description = None;
        node.value = Some("hello".to_string());
        assert_eq!(label_of(&node), "hello");
        node.editable = true;
        node.placeholder = Some("Search".to_string());
        assert_eq!(label_of(&node), "Search");
    }

    #[test]
    fn pruning_drops_tiny_and_nameless_structure() {
        let save = button("Save");
        assert!(is_interesting(&save, "Save"));
        let mut tiny = button("x");
        tiny.frame = Some(rect(2.0, 2.0));
        assert!(!is_interesting(&tiny, "x"));
        let group = RawNode {
            role: "AXGroup".to_string(),
            frame: Some(rect(300.0, 300.0)),
            ..RawNode::default()
        };
        assert!(!is_interesting(&group, ""));
        let text = RawNode {
            role: "AXStaticText".to_string(),
            value: Some("Welcome".to_string()),
            frame: Some(rect(100.0, 20.0)),
            ..RawNode::default()
        };
        assert!(is_interesting(&text, &label_of(&text)));
    }

    #[test]
    fn secure_values_are_never_exposed() {
        let mut node = button("Password");
        node.role = "AXTextField".to_string();
        node.secure = true;
        node.value = Some("hunter2".to_string());
        let element = to_element(4, 0, &node, "Password".to_string(), true);
        assert_eq!(element.value, None);
        assert_eq!(element.id, "s4:e0");
    }

    #[test]
    fn ring_resolves_and_expires() {
        let mut ring: SnapshotRing<u8> = SnapshotRing::default();
        let seq = ring.next_seq();
        let element = to_element(seq, 0, &button("Go"), "Go".to_string(), true);
        ring.insert(seq, 42, None, vec![element], vec![7]);
        let (snapshot, index) = ring.lookup(&format!("s{seq}:e0")).unwrap();
        assert_eq!(snapshot.handles[index], 7);
        assert_eq!(
            ring.lookup(&format!("s{seq}:e9")).err().unwrap().code,
            ComputerErrorCode::ElementNotFound
        );
        assert_eq!(
            ring.lookup("s999:e0").err().unwrap().code,
            ComputerErrorCode::SnapshotExpired
        );
        assert_eq!(
            ring.lookup("nope").err().unwrap().code,
            ComputerErrorCode::InvalidPayload
        );
    }

    #[test]
    fn displays_bound_on_screen_frames() {
        let display = rect(1000.0, 800.0);
        assert!(on_any_display(
            &rect(10.0, 10.0),
            std::slice::from_ref(&display)
        ));
        let off = ComputerRect {
            x: 2000.0,
            ..rect(10.0, 10.0)
        };
        assert!(!on_any_display(&off, &[display]));
    }
}
