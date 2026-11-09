//! Walking one window's accessibility tree into a pruned snapshot.

use std::time::Instant;

use pragma_constants::{ComputerElement, ComputerRect};

use super::ffi::{self, Element};
use crate::snapshot::{
    is_interesting, label_of, normalize_role, on_any_display, to_element, RawNode, WalkLimits,
};

/// What a walk produced: the kept elements and their handles, in order.
pub struct Walked {
    pub elements: Vec<ComputerElement>,
    pub handles: Vec<Element>,
    pub node_count: u64,
    pub truncated: bool,
    pub focused_index: Option<usize>,
}

/// Reads one node's attributes.
pub fn read_node(element: &Element, path: Vec<u64>, ancestor_roles: Vec<String>) -> RawNode {
    let role = ffi::string(element, "AXRole").unwrap_or_default();
    let subrole = ffi::string(element, "AXSubrole");
    let frame = match (ffi::position(element), ffi::size(element)) {
        (Some(origin), Some(size)) => Some(ComputerRect {
            x: origin.x,
            y: origin.y,
            w: size.width,
            h: size.height,
            display_id: None,
        }),
        _ => None,
    };
    let secure = subrole.as_deref() == Some("AXSecureTextField");
    let text_role = matches!(
        role.as_str(),
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"
    );
    let editable = text_role && ffi::settable(element, "AXValue");
    let actions = ffi::actions(element)
        .into_iter()
        .filter(|action| {
            !matches!(
                action.as_str(),
                "AXScrollToVisible" | "AXShowDefaultUI" | "AXShowAlternateUI"
            )
        })
        .map(|action| action.strip_prefix("AX").unwrap_or(&action).to_lowercase())
        .collect();
    RawNode {
        subrole,
        title: ffi::string(element, "AXTitle"),
        description: ffi::string(element, "AXDescription"),
        // A secure field's value is never read, not even into memory here.
        value: if secure {
            None
        } else {
            ffi::string(element, "AXValue")
        },
        placeholder: ffi::string(element, "AXPlaceholderValue"),
        identifier: ffi::string(element, "AXIdentifier"),
        frame,
        enabled: ffi::boolean(element, "AXEnabled").unwrap_or(true),
        focused: ffi::boolean(element, "AXFocused").unwrap_or(false),
        editable,
        secure,
        offscreen: false,
        actions,
        path,
        ancestor_roles,
        role,
    }
}

/// Walks `window` depth-first, pruning as it goes.
pub fn walk(
    window: &Element,
    snapshot: u64,
    limits: &WalkLimits,
    displays: &[ComputerRect],
) -> Walked {
    let started = Instant::now();
    let mut out = Walked {
        elements: Vec::new(),
        handles: Vec::new(),
        node_count: 0,
        truncated: false,
        focused_index: None,
    };
    let mut offscreen_kept = 0usize;
    let max_offscreen =
        usize::try_from(pragma_constants::CONSTANTS.computer.max_offscreen_elements).unwrap_or(50);
    // A stack of (element, path, ancestor roles); children are pushed in
    // reverse so the walk visits them in reading order.
    let mut stack: Vec<(Element, Vec<u64>, Vec<String>)> =
        vec![(window.clone(), Vec::new(), Vec::new())];
    while let Some((element, path, ancestors)) = stack.pop() {
        if usize::try_from(out.node_count).unwrap_or(usize::MAX) >= limits.max_nodes
            || started.elapsed() > limits.budget
        {
            out.truncated = true;
            break;
        }
        out.node_count += 1;
        let node = read_node(&element, path.clone(), ancestors.clone());
        let visible = node
            .frame
            .as_ref()
            .is_none_or(|frame| displays.is_empty() || on_any_display(frame, displays));
        // A closed menu's subtree and anything wholly off every display only
        // confuse a caller; frames lie less often than they are absent, so a
        // node without a frame is kept.
        if node.role == "AXMenu" && !visible {
            continue;
        }
        if !visible && !limits.include_offscreen && !path.is_empty() {
            continue;
        }
        let label = label_of(&node);
        if !path.is_empty()
            && is_interesting(&node, &label)
            && (visible || offscreen_kept < max_offscreen)
        {
            if !visible {
                offscreen_kept += 1;
            }
            let index = u32::try_from(out.elements.len()).unwrap_or(u32::MAX);
            if node.focused {
                out.focused_index = Some(out.elements.len());
            }
            out.elements
                .push(to_element(snapshot, index, &node, label, visible));
            out.handles.push(element.clone());
        }
        if path.len() >= limits.max_depth {
            continue;
        }
        let children = ffi::elements(&element, "AXChildren");
        let mut child_ancestors = ancestors;
        child_ancestors.push(normalize_role(&node.role));
        for (index, child) in children.into_iter().enumerate().rev() {
            let mut child_path = path.clone();
            child_path.push(index as u64);
            stack.push((child, child_path, child_ancestors.clone()));
        }
    }
    out
}
