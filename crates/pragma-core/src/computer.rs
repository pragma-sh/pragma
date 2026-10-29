//! Pure computer-use rules: lease arbitration, access policy, blocked and
//! sensitive targets, chord parsing, coordinate mapping, element ids, and
//! element revalidation.
//!
//! Everything here is deterministic and side-effect free so it can be tested
//! without a helper process, an accessibility grant, or a display. The live
//! sessions, the helper supervision, and the activity stream live in
//! `pragma-server`'s `computer` module, which calls into this one; the native
//! accessibility, capture, and input calls live in `pragma-computer`.

use std::collections::BTreeMap;

use pragma_constants::{
    ComputerAccess, ComputerCaller, ComputerCallerKind, ComputerCommandSpec, ComputerElement,
    ComputerErrorCode, ComputerFailure, ComputerOp, ComputerPoint, ComputerRect,
    ComputerUseSettings, CONSTANTS,
};

// ------------------------------------------------------------------ failures

/// Builds a computer-use failure. Whether it is retryable follows from the code.
#[must_use]
pub fn failure(code: ComputerErrorCode, message: impl Into<String>) -> ComputerFailure {
    ComputerFailure {
        code,
        message: message.into(),
        retryable: is_retryable(code),
        hint: None,
        details: serde_json::Map::new(),
    }
}

/// True when the same call may succeed later without anyone changing anything.
#[must_use]
pub fn is_retryable(code: ComputerErrorCode) -> bool {
    matches!(
        code,
        ComputerErrorCode::AppBusy
            | ComputerErrorCode::InputBusy
            | ComputerErrorCode::UserTakeover
            | ComputerErrorCode::ElementStale
            | ComputerErrorCode::SnapshotExpired
            | ComputerErrorCode::TargetChanged
            | ComputerErrorCode::SecureInputActive
            | ComputerErrorCode::Timeout
            | ComputerErrorCode::HelperUnavailable
    )
}

/// The protocol-level code a computer failure surfaces as. The computer code
/// itself rides along in the error details.
#[must_use]
pub fn protocol_code(code: ComputerErrorCode) -> pragma_constants::ProtocolErrorCode {
    use pragma_constants::ProtocolErrorCode as Protocol;
    match code {
        ComputerErrorCode::PermissionMissing
        | ComputerErrorCode::NotAuthorized
        | ComputerErrorCode::Disabled
        | ComputerErrorCode::BlockedApp
        | ComputerErrorCode::ApprovalRequired
        | ComputerErrorCode::Denied
        | ComputerErrorCode::IndicatorUnavailable
        | ComputerErrorCode::TargetElevated
        | ComputerErrorCode::SecureInputActive => Protocol::PermissionDenied,
        ComputerErrorCode::AppNotFound
        | ComputerErrorCode::WindowNotFound
        | ComputerErrorCode::ElementNotFound => Protocol::NotFound,
        ComputerErrorCode::ElementStale
        | ComputerErrorCode::SnapshotExpired
        | ComputerErrorCode::TargetChanged
        | ComputerErrorCode::AppBusy
        | ComputerErrorCode::InputBusy
        | ComputerErrorCode::UserTakeover
        | ComputerErrorCode::Stopped
        | ComputerErrorCode::WindowMinimized => Protocol::StaleWrite,
        ComputerErrorCode::InvalidPayload => Protocol::InvalidPayload,
        ComputerErrorCode::UnsupportedPlatform => Protocol::UnsupportedMethod,
        ComputerErrorCode::Timeout
        | ComputerErrorCode::HelperUnavailable
        | ComputerErrorCode::Internal => Protocol::Internal,
    }
}

// ------------------------------------------------------------------ registry

/// The registry row for one operation.
///
/// # Panics
///
/// Panics when `values.json` lacks a row for `op`, which `registry_is_complete`
/// pins in a test so it can only happen on a broken checkout.
#[must_use]
pub fn command_spec(op: ComputerOp) -> &'static ComputerCommandSpec {
    CONSTANTS
        .computer
        .commands
        .iter()
        .find(|spec| spec.op == op)
        .expect("every ComputerOp has a registry row")
}

// ------------------------------------------------------------------ identity

/// Stable lease key for an app: its bundle id, AUMID, or exe path, lower-cased.
///
/// Lower-casing matches how both platforms compare these identifiers: bundle
/// ids and Windows paths are case-insensitive in practice.
#[must_use]
pub fn app_key(identifier: &str) -> String {
    identifier.trim().to_lowercase()
}

/// A short display label for a caller, for the sidebar and the approval prompt.
#[must_use]
pub fn caller_label(caller: &ComputerCaller) -> String {
    if let Some(label) = caller.label.as_deref().filter(|label| !label.is_empty()) {
        return label.to_string();
    }
    match caller.kind {
        ComputerCallerKind::AgentTab => caller
            .agent_id
            .clone()
            .unwrap_or_else(|| "Agent".to_string()),
        ComputerCallerKind::Plugin => caller
            .plugin_id
            .clone()
            .unwrap_or_else(|| "Plugin".to_string()),
        ComputerCallerKind::Sdk => "Script".to_string(),
        ComputerCallerKind::User => "You".to_string(),
    }
}

/// The key a caller's session is filed under: one session per owner.
#[must_use]
pub fn owner_key(caller: &ComputerCaller) -> String {
    match caller.kind {
        ComputerCallerKind::AgentTab => {
            format!("tab:{}", caller.tab_id.as_deref().unwrap_or_default())
        }
        ComputerCallerKind::Plugin => {
            format!("plugin:{}", caller.plugin_id.as_deref().unwrap_or_default())
        }
        ComputerCallerKind::Sdk => "sdk".to_string(),
        ComputerCallerKind::User => "user".to_string(),
    }
}

/// The key a persisted grant is filed under. Agents are granted per agent, not
/// per tab, so "always for this agent" survives a new tab.
#[must_use]
pub fn grant_key(caller: &ComputerCaller) -> String {
    match caller.kind {
        ComputerCallerKind::AgentTab => {
            format!("agent:{}", caller.agent_id.as_deref().unwrap_or("*"))
        }
        ComputerCallerKind::Plugin => {
            format!("plugin:{}", caller.plugin_id.as_deref().unwrap_or("*"))
        }
        ComputerCallerKind::Sdk => "sdk".to_string(),
        ComputerCallerKind::User => "user".to_string(),
    }
}

// ------------------------------------------------------------------ policy

/// The configured access for a caller, before any persisted grant is applied.
///
/// The desktop user is always allowed; everyone else defaults to `ask`.
#[must_use]
pub fn configured_access(
    settings: &ComputerUseSettings,
    caller: &ComputerCaller,
) -> ComputerAccess {
    let access = settings.access.as_ref();
    match caller.kind {
        ComputerCallerKind::User => ComputerAccess::Allow,
        ComputerCallerKind::AgentTab => access
            .and_then(|policy| lookup(&policy.agents, caller.agent_id.as_deref()))
            .unwrap_or(ComputerAccess::Ask),
        ComputerCallerKind::Plugin => access
            .and_then(|policy| lookup(&policy.plugins, caller.plugin_id.as_deref()))
            .unwrap_or(ComputerAccess::Ask),
        ComputerCallerKind::Sdk => access
            .and_then(|policy| policy.sdk)
            .unwrap_or(ComputerAccess::Ask),
    }
}

fn lookup(
    map: &std::collections::HashMap<String, ComputerAccess>,
    id: Option<&str>,
) -> Option<ComputerAccess> {
    id.and_then(|id| map.get(id))
        .or_else(|| map.get("*"))
        .copied()
}

/// Whether computer use is switched on at all. Off unless explicitly enabled.
#[must_use]
pub fn is_enabled(settings: &ComputerUseSettings) -> bool {
    settings.enabled == Some(true)
}

// ------------------------------------------------------------------ targets

/// Identifiers that always name Pragma itself, whatever the user configures.
///
/// An agent that could click Pragma's windows could approve its own request.
#[must_use]
pub fn pragma_identifiers() -> Vec<String> {
    let identifier = &CONSTANTS.app.identifier;
    vec![
        format!("mac:{identifier}"),
        format!("mac:{identifier}.dev"),
        format!("mac:{}", CONSTANTS.computer.mac_helper_bundle_id),
        "win:pragma.exe".to_string(),
        "win:pragma-dev.exe".to_string(),
        format!("win:{}.exe", CONSTANTS.computer.helper_name),
    ]
}

/// One app's identity, as the block list matches it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppIdentity<'a> {
    /// macOS bundle identifier.
    pub bundle_id: Option<&'a str>,
    /// Windows executable path, or a macOS bundle path.
    pub path: Option<&'a str>,
    /// Display name.
    pub name: &'a str,
}

/// True when `app` is on the shipped block list, the user's extra entries, or
/// is Pragma itself.
#[must_use]
pub fn is_blocked(app: &AppIdentity<'_>, extra: &[String]) -> bool {
    let candidates = block_candidates(app);
    pragma_identifiers()
        .iter()
        .chain(CONSTANTS.computer.blocked_apps.iter())
        .chain(extra.iter())
        .any(|entry| {
            candidates
                .iter()
                .any(|candidate| *candidate == entry.to_lowercase())
        })
}

fn block_candidates(app: &AppIdentity<'_>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(bundle) = app.bundle_id {
        out.push(format!("mac:{}", bundle.to_lowercase()));
    }
    if let Some(path) = app.path {
        // A path is matched by its file name, which is how the shipped list
        // names Windows executables; separators differ per platform.
        let file = path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(path)
            .to_lowercase();
        out.push(format!("win:{file}"));
    }
    if app.name.eq_ignore_ascii_case("pragma") || app.name.eq_ignore_ascii_case("pragma dev") {
        out.push(format!("mac:{}", CONSTANTS.app.identifier.to_lowercase()));
    }
    out
}

/// True when a control's label marks it as sensitive (Delete, Send, Pay, …).
///
/// Matched on whole words so "Undelete" or "Resend later" is not caught by a
/// substring, but "Delete repository" is.
#[must_use]
pub fn is_sensitive_label(label: &str) -> bool {
    let words = normalize_label(label);
    CONSTANTS.computer.sensitive_labels.iter().any(|needle| {
        let needle = normalize_label(needle);
        !needle.is_empty() && contains_words(&words, &needle)
    })
}

fn contains_words(haystack: &str, needle: &str) -> bool {
    let hay: Vec<&str> = haystack.split(' ').collect();
    let need: Vec<&str> = needle.split(' ').collect();
    hay.windows(need.len())
        .any(|window| window == need.as_slice())
}

/// Lower-cases and collapses a label to space-separated alphanumeric words.
#[must_use]
pub fn normalize_label(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Truncates untrusted screen text to the shipped label cap, on a char boundary.
#[must_use]
pub fn truncate_label(text: &str) -> String {
    let max = usize::try_from(CONSTANTS.computer.label_max_chars.get()).unwrap_or(80);
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// How typed text appears in activity and logs: never the text itself.
#[must_use]
pub fn redact_text(text: &str) -> String {
    format!("•••• ({} chars)", text.chars().count())
}

// ------------------------------------------------------------------ leases

/// Exclusive per-app leases, keyed by app key, each held by one session.
///
/// "Never control the same app twice": a second session asking for an app
/// another session holds is refused with the holder named, rather than queued.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LeaseTable {
    holders: BTreeMap<String, String>,
}

/// The outcome of a lease request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseOutcome {
    /// The session now holds the lease, newly or already.
    Granted { newly: bool },
    /// Another session holds it.
    Busy { holder: String },
}

impl LeaseTable {
    /// Requests `app_key` for `session`.
    pub fn acquire(&mut self, app_key: &str, session: &str) -> LeaseOutcome {
        match self.holders.get(app_key) {
            Some(holder) if holder == session => LeaseOutcome::Granted { newly: false },
            Some(holder) => LeaseOutcome::Busy {
                holder: holder.clone(),
            },
            None => {
                self.holders
                    .insert(app_key.to_string(), session.to_string());
                LeaseOutcome::Granted { newly: true }
            }
        }
    }

    /// The session holding `app_key`, if any.
    #[must_use]
    pub fn holder(&self, app_key: &str) -> Option<&str> {
        self.holders.get(app_key).map(String::as_str)
    }

    /// Releases every lease `session` holds and returns their app keys.
    pub fn release_session(&mut self, session: &str) -> Vec<String> {
        let released: Vec<String> = self
            .holders
            .iter()
            .filter(|(_, holder)| holder.as_str() == session)
            .map(|(app, _)| app.clone())
            .collect();
        for app in &released {
            self.holders.remove(app);
        }
        released
    }

    /// Releases everything.
    pub fn clear(&mut self) {
        self.holders.clear();
    }
}

/// True when a session has been idle for at least `idle_ms`.
#[must_use]
pub fn is_idle(last_action_at: i64, now: i64, idle_ms: i64) -> bool {
    now.saturating_sub(last_action_at) >= idle_ms
}

/// The macOS `AXMenuItemCmdModifiers` mask a menu item carries for `chord`,
/// when the chord is a menu shortcut (it holds Command or Control): Shift 1,
/// Option 2, Control 4, and 8 when Command is *not* held.
#[must_use]
pub fn ax_menu_modifiers(chord: &Chord) -> Option<i64> {
    let held = |modifier| chord.modifiers.contains(&modifier);
    if !held(Modifier::Cmd) && !held(Modifier::Ctrl) {
        return None;
    }
    let mut mask = 0;
    if held(Modifier::Shift) {
        mask |= 1;
    }
    if held(Modifier::Alt) {
        mask |= 2;
    }
    if held(Modifier::Ctrl) {
        mask |= 4;
    }
    if !held(Modifier::Cmd) {
        mask |= 8;
    }
    Some(mask)
}

// ------------------------------------------------------------------ takeover

/// Deliberate physical input this recent, aimed at the target, is the user
/// working in it right now.
pub const TAKEOVER_WINDOW_SECONDS: f64 = 1.0;

/// What the user is physically doing, relative to the app an action targets.
///
/// Only deliberate input counts: key presses, and clicks, drags, and scrolls.
/// Merely moving the pointer never does, and neither does input that lands in
/// another app.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserActivity {
    /// Seconds since the last physical key press; `None` when unknown.
    pub keyboard_seconds: Option<f64>,
    /// Seconds since the last physical click, drag, or scroll; `None` when unknown.
    pub pointer_seconds: Option<f64>,
    /// Whether the target app is frontmost, so the user's keystrokes reach it.
    pub target_frontmost: bool,
    /// Whether the topmost window under the pointer belongs to the target app.
    pub pointer_over_target: bool,
}

/// True when the user is working in the target app right now: typing while it
/// is frontmost, or clicking, dragging, or scrolling in its window.
#[must_use]
pub fn is_user_takeover(activity: &UserActivity) -> bool {
    let recent = |seconds: Option<f64>| seconds.is_some_and(|s| s < TAKEOVER_WINDOW_SECONDS);
    (activity.target_frontmost && recent(activity.keyboard_seconds))
        || (activity.pointer_over_target && recent(activity.pointer_seconds))
}

// ------------------------------------------------------------------ chords

/// A modifier key. `Mod` is resolved to `Cmd` on macOS and `Ctrl` elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Cmd,
}

/// A non-character key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKey {
    Enter,
    Escape,
    Tab,
    Space,
    Backspace,
    Delete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F(u8),
}

/// The key a chord presses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Named(NamedKey),
    /// A printable character, lower-cased for letters.
    Char(char),
}

/// One parsed chord: its modifiers (sorted, de-duplicated) and its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Vec<Modifier>,
    pub key: Key,
}

/// The platform a chord is resolved for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChordPlatform {
    Mac,
    Other,
}

impl ChordPlatform {
    /// The platform this binary was built for.
    #[must_use]
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Other
        }
    }
}

/// Parses `mod+shift+l`, `enter`, `cmd+,`, `ctrl+alt+delete`, `f5`.
///
/// Accepts `+` as the separator and the usual aliases (`command`, `option`,
/// `control`, `return`, `esc`, `arrowup`, `pgdn`, …). `+` itself is spelled
/// `plus`.
pub fn parse_chord(text: &str, platform: ChordPlatform) -> Result<Chord, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("empty chord".to_string());
    }
    let parts: Vec<&str> = trimmed.split('+').map(str::trim).collect();
    let (key_part, modifier_parts) = parts
        .split_last()
        .ok_or_else(|| format!("invalid chord `{text}`"))?;
    let mut modifiers = Vec::new();
    for part in modifier_parts {
        let modifier = parse_modifier(part, platform)
            .ok_or_else(|| format!("unknown modifier `{part}` in `{text}`"))?;
        if !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }
    modifiers.sort();
    let key = parse_key(key_part).ok_or_else(|| format!("unknown key `{key_part}` in `{text}`"))?;
    Ok(Chord { modifiers, key })
}

fn parse_modifier(part: &str, platform: ChordPlatform) -> Option<Modifier> {
    Some(match part.to_ascii_lowercase().as_str() {
        "mod" | "primary" => match platform {
            ChordPlatform::Mac => Modifier::Cmd,
            ChordPlatform::Other => Modifier::Ctrl,
        },
        "ctrl" | "control" => Modifier::Ctrl,
        "alt" | "option" | "opt" => Modifier::Alt,
        "shift" => Modifier::Shift,
        "cmd" | "command" | "meta" | "super" | "win" => Modifier::Cmd,
        _ => return None,
    })
}

fn parse_key(part: &str) -> Option<Key> {
    let lower = part.to_ascii_lowercase();
    let named = match lower.as_str() {
        "enter" | "return" => NamedKey::Enter,
        "escape" | "esc" => NamedKey::Escape,
        "tab" => NamedKey::Tab,
        "space" => NamedKey::Space,
        "backspace" => NamedKey::Backspace,
        "delete" | "del" | "forwarddelete" => NamedKey::Delete,
        "up" | "arrowup" => NamedKey::Up,
        "down" | "arrowdown" => NamedKey::Down,
        "left" | "arrowleft" => NamedKey::Left,
        "right" | "arrowright" => NamedKey::Right,
        "home" => NamedKey::Home,
        "end" => NamedKey::End,
        "pageup" | "page_up" | "pgup" => NamedKey::PageUp,
        "pagedown" | "page_down" | "pgdn" => NamedKey::PageDown,
        "plus" => return Some(Key::Char('+')),
        _ => {
            if let Some(number) = lower.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                if (1..=24).contains(&number) {
                    return Some(Key::Named(NamedKey::F(number)));
                }
            }
            let mut chars = part.chars();
            let first = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            return Some(Key::Char(first.to_ascii_lowercase()));
        }
    };
    Some(Key::Named(named))
}

// ------------------------------------------------------------------ geometry

/// Maps a point in a screenshot's pixels back to screen space.
#[must_use]
pub fn image_to_screen(
    origin: &ComputerPoint,
    scale: f64,
    image_x: f64,
    image_y: f64,
) -> ComputerPoint {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    ComputerPoint {
        x: origin.x + image_x / scale,
        y: origin.y + image_y / scale,
    }
}

/// The centre of a rectangle.
#[must_use]
pub fn rect_center(rect: &ComputerRect) -> ComputerPoint {
    ComputerPoint {
        x: rect.x + rect.w / 2.0,
        y: rect.y + rect.h / 2.0,
    }
}

/// The overlap of two rectangles, if they overlap at all.
#[must_use]
pub fn rect_intersection(a: &ComputerRect, b: &ComputerRect) -> Option<ComputerRect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.w).min(b.x + b.w);
    let bottom = (a.y + a.h).min(b.y + b.h);
    (right > x && bottom > y).then(|| ComputerRect {
        x,
        y,
        w: right - x,
        h: bottom - y,
        display_id: a.display_id.clone(),
    })
}

/// Where to act on an element: the centre of the part of it that is actually
/// visible inside every clip around it (its scroll view, its window).
///
/// A text area or a long list is often far taller than the view showing it,
/// so the centre of its whole frame can lie below the window, where a click
/// lands in another app and the overlay cursor floats over it. `None` when
/// none of it is visible.
#[must_use]
pub fn visible_center(frame: &ComputerRect, clips: &[ComputerRect]) -> Option<ComputerPoint> {
    clips
        .iter()
        .try_fold(frame.clone(), |visible, clip| {
            rect_intersection(&visible, clip)
        })
        .map(|visible| rect_center(&visible))
}

/// True when `point` lies inside `rect` (edges inclusive).
#[must_use]
pub fn rect_contains(rect: &ComputerRect, point: &ComputerPoint) -> bool {
    point.x >= rect.x
        && point.y >= rect.y
        && point.x <= rect.x + rect.w
        && point.y <= rect.y + rect.h
}

/// Where the overlay cursor sits, relative to the window it acted in, so it
/// can follow that window after the action.
#[derive(Debug, Clone, PartialEq)]
pub struct CursorAnchor {
    pub window_id: String,
    /// The cursor's offset from the window's top-left corner.
    pub dx: f64,
    pub dy: f64,
}

impl CursorAnchor {
    /// Anchors `point` to `window`.
    #[must_use]
    pub fn new(window_id: &str, window: &ComputerRect, point: &ComputerPoint) -> Self {
        Self {
            window_id: window_id.to_string(),
            dx: point.x - window.x,
            dy: point.y - window.y,
        }
    }
}

/// Where an anchored cursor is now.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackedCursor {
    pub point: ComputerPoint,
    /// The window's current frame; `None` once it is gone (closed, minimized,
    /// or its app hidden), and the cursor is hidden with it.
    pub window: Option<ComputerRect>,
    /// Another window is in front of the cursor's point.
    pub covered: bool,
}

/// Re-places an anchored cursor against the current window list, which is in
/// front-to-back order (how every backend lists `windows`).
#[must_use]
pub fn track_cursor(
    windows: &[pragma_constants::ComputerWindow],
    anchor: &CursorAnchor,
) -> Option<TrackedCursor> {
    let index = windows.iter().position(|w| w.id == anchor.window_id)?;
    let frame = windows[index].frame.clone();
    let point = ComputerPoint {
        x: frame.x + anchor.dx,
        y: frame.y + anchor.dy,
    };
    let covered = windows[..index]
        .iter()
        .any(|w| rect_contains(&w.frame, &point));
    Some(TrackedCursor {
        point,
        window: Some(frame),
        covered,
    })
}

/// Parses `x,y` into a point.
#[must_use]
pub fn parse_point(text: &str) -> Option<ComputerPoint> {
    let (x, y) = text.split_once(',')?;
    Some(ComputerPoint {
        x: x.trim().parse().ok()?,
        y: y.trim().parse().ok()?,
    })
}

// ------------------------------------------------------------------ element ids

/// A parsed element id: `s42:e12` is element 12 of snapshot 42.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementRef {
    pub snapshot: u64,
    pub element: u32,
}

/// Formats a snapshot id (`s42`).
#[must_use]
pub fn snapshot_id(seq: u64) -> String {
    format!("s{seq}")
}

/// Formats an element id (`s42:e12`).
#[must_use]
pub fn element_id(snapshot: u64, element: u32) -> String {
    format!("s{snapshot}:e{element}")
}

/// Parses `s<seq>`.
#[must_use]
pub fn parse_snapshot_id(text: &str) -> Option<u64> {
    text.strip_prefix('s')?.parse().ok()
}

/// Parses `s<seq>:e<index>`.
#[must_use]
pub fn parse_element_id(text: &str) -> Option<ElementRef> {
    let (snapshot, element) = text.trim().split_once(':')?;
    Some(ElementRef {
        snapshot: parse_snapshot_id(snapshot)?,
        element: element.strip_prefix('e')?.parse().ok()?,
    })
}

/// A short fingerprint that correlates one control across snapshots: its role,
/// its identifier or label, and the roles of its ancestors.
#[must_use]
pub fn element_key(
    role: &str,
    identifier: Option<&str>,
    label: &str,
    ancestor_roles: &[&str],
) -> String {
    // FNV-1a: stable across builds and platforms, which `DefaultHasher` is not.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |text: &str| {
        for byte in text.bytes().chain(std::iter::once(0x1f)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    feed(role);
    match identifier.filter(|id| !id.is_empty()) {
        Some(identifier) => feed(identifier),
        None => feed(&normalize_label(label)),
    }
    for ancestor in ancestor_roles {
        feed(ancestor);
    }
    format!("k_{:06x}", hash & 0x00ff_ffff)
}

/// The outcome of re-finding a stored element in a fresh tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Revalidation {
    /// The element at the stored path is still the same control.
    SamePath(usize),
    /// The control moved, and exactly one fresh element matches it.
    Moved(usize),
    /// Nothing unique matches; up to five similar candidates are offered.
    Stale(Vec<usize>),
}

/// Re-finds `stored` among `fresh`, in the order §5.3 of the plan sets out:
/// the same path with a matching role and identity first, then a unique match
/// by identifier, then a unique match by role and label.
#[must_use]
pub fn revalidate(stored: &ComputerElement, fresh: &[ComputerElement]) -> Revalidation {
    if let Some(index) = fresh
        .iter()
        .position(|candidate| candidate.path == stored.path)
    {
        if same_identity(stored, &fresh[index]) {
            return Revalidation::SamePath(index);
        }
    }
    if let Some(identifier) = stored.identifier.as_deref().filter(|id| !id.is_empty()) {
        let matches: Vec<usize> = fresh
            .iter()
            .enumerate()
            .filter(|(_, candidate)| {
                candidate.role == stored.role && candidate.identifier.as_deref() == Some(identifier)
            })
            .map(|(index, _)| index)
            .collect();
        if let [only] = matches.as_slice() {
            return Revalidation::Moved(*only);
        }
    }
    let label = normalize_label(&stored.label);
    let matches: Vec<usize> = fresh
        .iter()
        .enumerate()
        .filter(|(_, candidate)| {
            !label.is_empty()
                && candidate.role == stored.role
                && normalize_label(&candidate.label) == label
        })
        .map(|(index, _)| index)
        .collect();
    if let [only] = matches.as_slice() {
        return Revalidation::Moved(*only);
    }
    let mut similar: Vec<usize> = matches;
    if similar.is_empty() {
        similar = fresh
            .iter()
            .enumerate()
            .filter(|(_, candidate)| candidate.role == stored.role)
            .map(|(index, _)| index)
            .collect();
    }
    similar.truncate(5);
    Revalidation::Stale(similar)
}

fn same_identity(stored: &ComputerElement, candidate: &ComputerElement) -> bool {
    if stored.role != candidate.role {
        return false;
    }
    match (
        stored.identifier.as_deref(),
        candidate.identifier.as_deref(),
    ) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => a == b,
        _ => normalize_label(&stored.label) == normalize_label(&candidate.label),
    }
}

/// Keeps the elements that match a free-text query on label, value, or
/// identifier, case-insensitively.
#[must_use]
pub fn matches_query(element: &ComputerElement, query: &str) -> bool {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    [
        Some(element.label.as_str()),
        element.value.as_deref(),
        element.identifier.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|text| text.to_lowercase().contains(&needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pragma_constants::ComputerAccessPolicy;

    fn element(
        path: Vec<u64>,
        role: &str,
        label: &str,
        identifier: Option<&str>,
    ) -> ComputerElement {
        ComputerElement {
            id: "s1:e0".to_string(),
            key: String::new(),
            role: role.to_string(),
            subrole: None,
            label: label.to_string(),
            identifier: identifier.map(str::to_string),
            value: None,
            enabled: true,
            focused: false,
            editable: false,
            secure: false,
            actions: vec!["press".to_string()],
            frame: None,
            on_screen: true,
            path,
            depth: 0,
        }
    }

    fn agent(id: &str) -> ComputerCaller {
        ComputerCaller {
            kind: ComputerCallerKind::AgentTab,
            tab_id: Some("tab-1".to_string()),
            worktree_id: None,
            agent_id: Some(id.to_string()),
            plugin_id: None,
            label: None,
        }
    }

    #[test]
    fn registry_is_complete() {
        for op in [
            ComputerOp::Apps,
            ComputerOp::Windows,
            ComputerOp::Displays,
            ComputerOp::Open,
            ComputerOp::Focus,
            ComputerOp::Inspect,
            ComputerOp::Screenshot,
            ComputerOp::Click,
            ComputerOp::Type,
            ComputerOp::Key,
            ComputerOp::Scroll,
            ComputerOp::Move,
            ComputerOp::Drag,
            ComputerOp::Status,
            ComputerOp::End,
            ComputerOp::Permissions,
            ComputerOp::Frame,
            ComputerOp::Approve,
            ComputerOp::Pause,
            ComputerOp::Unpause,
            ComputerOp::Stop,
            ComputerOp::Run,
            ComputerOp::Resume,
            ComputerOp::Cancel,
            ComputerOp::Task,
        ] {
            assert_eq!(command_spec(op).op, op);
        }
        assert!(command_spec(ComputerOp::Click).mutating);
        assert!(!command_spec(ComputerOp::Inspect).mutating);
        assert!(command_spec(ComputerOp::Stop).desktop_only);
    }

    #[test]
    fn leases_are_exclusive_per_app() {
        let mut leases = LeaseTable::default();
        assert_eq!(
            leases.acquire("com.apple.safari", "cs_a"),
            LeaseOutcome::Granted { newly: true }
        );
        assert_eq!(
            leases.acquire("com.apple.safari", "cs_a"),
            LeaseOutcome::Granted { newly: false }
        );
        assert_eq!(
            leases.acquire("com.apple.safari", "cs_b"),
            LeaseOutcome::Busy {
                holder: "cs_a".to_string()
            }
        );
        assert_eq!(
            leases.acquire("com.apple.textedit", "cs_b"),
            LeaseOutcome::Granted { newly: true }
        );
        assert_eq!(
            leases.release_session("cs_a"),
            vec!["com.apple.safari".to_string()]
        );
        assert_eq!(leases.holder("com.apple.safari"), None);
        assert_eq!(leases.holder("com.apple.textedit"), Some("cs_b"));
    }

    #[test]
    fn menu_shortcut_masks_match_appkit() {
        let mask = |text| ax_menu_modifiers(&parse_chord(text, ChordPlatform::Mac).unwrap());
        assert_eq!(mask("cmd+a"), Some(0));
        assert_eq!(mask("cmd+shift+s"), Some(1));
        assert_eq!(mask("cmd+alt+i"), Some(2));
        assert_eq!(mask("ctrl+tab"), Some(4 | 8));
        assert_eq!(mask("shift+a"), None);
        assert_eq!(mask("enter"), None);
    }

    #[test]
    fn takeover_needs_recent_input_aimed_at_the_target() {
        let typing = UserActivity {
            keyboard_seconds: Some(0.1),
            pointer_seconds: Some(60.0),
            ..UserActivity::default()
        };
        // Typing in another app leaves the agent alone…
        assert!(!is_user_takeover(&typing));
        // …typing into the target does not.
        assert!(is_user_takeover(&UserActivity {
            target_frontmost: true,
            ..typing.clone()
        }));
        let clicking = UserActivity {
            keyboard_seconds: Some(60.0),
            pointer_seconds: Some(0.2),
            target_frontmost: true,
            pointer_over_target: false,
        };
        // A click elsewhere, even with the target frontmost, is not a takeover.
        assert!(!is_user_takeover(&clicking));
        assert!(is_user_takeover(&UserActivity {
            pointer_over_target: true,
            ..clicking.clone()
        }));
        // Old input and unknown input never count.
        assert!(!is_user_takeover(&UserActivity {
            keyboard_seconds: Some(TAKEOVER_WINDOW_SECONDS),
            pointer_seconds: None,
            target_frontmost: true,
            pointer_over_target: true,
        }));
    }

    #[test]
    fn idle_threshold_is_inclusive() {
        assert!(!is_idle(1_000, 120_999, 120_000));
        assert!(is_idle(1_000, 121_000, 120_000));
    }

    #[test]
    fn access_defaults_to_ask_and_honours_wildcards() {
        let mut settings = ComputerUseSettings::default();
        assert!(!is_enabled(&settings));
        assert_eq!(
            configured_access(&settings, &agent("claude-code")),
            ComputerAccess::Ask
        );
        let mut agents = std::collections::HashMap::new();
        agents.insert("*".to_string(), ComputerAccess::Deny);
        agents.insert("claude-code".to_string(), ComputerAccess::Allow);
        settings.access = Some(ComputerAccessPolicy {
            agents,
            ..ComputerAccessPolicy::default()
        });
        settings.enabled = Some(true);
        assert!(is_enabled(&settings));
        assert_eq!(
            configured_access(&settings, &agent("claude-code")),
            ComputerAccess::Allow
        );
        assert_eq!(
            configured_access(&settings, &agent("opencode")),
            ComputerAccess::Deny
        );
        let user = ComputerCaller {
            kind: ComputerCallerKind::User,
            ..agent("x")
        };
        assert_eq!(configured_access(&settings, &user), ComputerAccess::Allow);
    }

    #[test]
    fn pragma_and_password_managers_are_blocked() {
        let pragma = AppIdentity {
            bundle_id: Some("com.pragma.app"),
            path: None,
            name: "Pragma",
        };
        assert!(is_blocked(&pragma, &[]));
        let keychain = AppIdentity {
            bundle_id: Some("com.apple.KeychainAccess"),
            path: None,
            name: "Keychain Access",
        };
        assert!(is_blocked(&keychain, &[]));
        let consent = AppIdentity {
            bundle_id: None,
            path: Some(r"C:\Windows\System32\consent.exe"),
            name: "Consent",
        };
        assert!(is_blocked(&consent, &[]));
        let safari = AppIdentity {
            bundle_id: Some("com.apple.Safari"),
            path: None,
            name: "Safari",
        };
        assert!(!is_blocked(&safari, &[]));
        assert!(is_blocked(&safari, &["mac:com.apple.safari".to_string()]));
    }

    #[test]
    fn sensitive_labels_match_whole_words() {
        assert!(is_sensitive_label("Delete repository"));
        assert!(is_sensitive_label("Sign out"));
        assert!(is_sensitive_label("SEND"));
        assert!(!is_sensitive_label("Undelete"));
        assert!(!is_sensitive_label("Sign in"));
        assert!(!is_sensitive_label("Settings"));
    }

    #[test]
    fn labels_are_truncated_and_text_redacted() {
        let long = "x".repeat(200);
        assert_eq!(truncate_label(&long).chars().count(), 81);
        assert_eq!(truncate_label("short"), "short");
        assert_eq!(redact_text("héllo"), "•••• (5 chars)");
    }

    #[test]
    fn chords_parse_with_platform_mod() {
        let mac = parse_chord("mod+shift+L", ChordPlatform::Mac).unwrap();
        assert_eq!(mac.modifiers, vec![Modifier::Shift, Modifier::Cmd]);
        assert_eq!(mac.key, Key::Char('l'));
        let win = parse_chord("mod+l", ChordPlatform::Other).unwrap();
        assert_eq!(win.modifiers, vec![Modifier::Ctrl]);
        assert_eq!(
            parse_chord("Return", ChordPlatform::Mac).unwrap().key,
            Key::Named(NamedKey::Enter)
        );
        assert_eq!(
            parse_chord("f5", ChordPlatform::Mac).unwrap().key,
            Key::Named(NamedKey::F(5))
        );
        assert_eq!(
            parse_chord("cmd+,", ChordPlatform::Mac).unwrap().key,
            Key::Char(',')
        );
        assert_eq!(
            parse_chord("ctrl+plus", ChordPlatform::Mac).unwrap().key,
            Key::Char('+')
        );
        assert!(parse_chord("hyper+x", ChordPlatform::Mac).is_err());
        assert!(parse_chord("ctrl+nope", ChordPlatform::Mac).is_err());
        assert!(parse_chord("", ChordPlatform::Mac).is_err());
    }

    #[test]
    fn image_points_map_back_to_screen() {
        let origin = ComputerPoint { x: 100.0, y: 50.0 };
        let point = image_to_screen(&origin, 2.0, 200.0, 100.0);
        assert!((point.x - 200.0).abs() < f64::EPSILON);
        assert!((point.y - 100.0).abs() < f64::EPSILON);
        let rect = ComputerRect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 20.0,
            display_id: None,
        };
        let center = rect_center(&rect);
        assert!(rect_contains(&rect, &center));
        assert!(!rect_contains(&rect, &ComputerPoint { x: 11.0, y: 1.0 }));
        let parsed = parse_point(" 12.5, 7 ").unwrap();
        assert!((parsed.x - 12.5).abs() < f64::EPSILON);
        assert!(parse_point("12").is_none());
    }

    #[test]
    fn element_ids_round_trip() {
        assert_eq!(element_id(42, 12), "s42:e12");
        assert_eq!(
            parse_element_id("s42:e12"),
            Some(ElementRef {
                snapshot: 42,
                element: 12
            })
        );
        assert_eq!(parse_element_id("42:12"), None);
        assert_eq!(parse_snapshot_id("s7"), Some(7));
    }

    #[test]
    fn element_keys_are_stable_and_identity_sensitive() {
        let a = element_key("button", None, "Create  repository", &["window", "group"]);
        let b = element_key("button", None, "create repository", &["window", "group"]);
        let c = element_key("button", None, "Cancel", &["window", "group"]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("k_"));
    }

    #[test]
    fn revalidation_prefers_path_then_identifier_then_label() {
        let stored = element(vec![0, 1], "button", "Save", Some("save-btn"));
        let fresh = vec![
            element(vec![0, 0], "button", "Cancel", None),
            element(vec![0, 1], "button", "Save", Some("save-btn")),
        ];
        assert_eq!(revalidate(&stored, &fresh), Revalidation::SamePath(1));

        let moved = vec![
            element(vec![0, 1], "button", "Cancel", None),
            element(vec![0, 2], "button", "Save", Some("save-btn")),
        ];
        assert_eq!(revalidate(&stored, &moved), Revalidation::Moved(1));

        let no_id = element(vec![0, 1], "button", "Save", None);
        let by_label = vec![
            element(vec![0, 1], "button", "Cancel", None),
            element(vec![3], "button", "save", None),
        ];
        assert_eq!(revalidate(&no_id, &by_label), Revalidation::Moved(1));

        let ambiguous = vec![
            element(vec![1], "button", "Save", None),
            element(vec![2], "button", "Save", None),
        ];
        assert_eq!(
            revalidate(&no_id, &ambiguous),
            Revalidation::Stale(vec![0, 1])
        );
    }

    #[test]
    fn queries_match_label_value_and_identifier() {
        let mut field = element(
            vec![0],
            "textField",
            "Address and search",
            Some("url-field"),
        );
        field.value = Some("example.com".to_string());
        assert!(matches_query(&field, "address"));
        assert!(matches_query(&field, "EXAMPLE"));
        assert!(matches_query(&field, "url-"));
        assert!(!matches_query(&field, "bookmark"));
    }

    #[test]
    fn owner_and_grant_keys() {
        let caller = agent("claude-code");
        assert_eq!(owner_key(&caller), "tab:tab-1");
        assert_eq!(grant_key(&caller), "agent:claude-code");
        assert_eq!(caller_label(&caller), "claude-code");
    }

    fn listed(id: &str, x: f64, y: f64, w: f64, h: f64) -> pragma_constants::ComputerWindow {
        pragma_constants::ComputerWindow {
            id: id.to_string(),
            app_id: "app:test".to_string(),
            app_name: "Test".to_string(),
            pid: 1,
            title: String::new(),
            frame: ComputerRect {
                x,
                y,
                w,
                h,
                display_id: None,
            },
            focused: false,
            minimized: false,
            on_screen: true,
        }
    }

    #[test]
    fn tracked_cursor_follows_its_window() {
        let start = listed("w1", 100.0, 100.0, 400.0, 300.0);
        let anchor = CursorAnchor::new("w1", &start.frame, &ComputerPoint { x: 150.0, y: 120.0 });
        let moved = track_cursor(&[listed("w1", 300.0, 200.0, 400.0, 300.0)], &anchor).unwrap();
        assert_eq!(moved.point, ComputerPoint { x: 350.0, y: 220.0 });
        assert!(!moved.covered);
        assert!((moved.window.unwrap().x - 300.0).abs() < f64::EPSILON);
    }

    #[test]
    fn tracked_cursor_is_covered_only_by_windows_in_front() {
        let target = listed("w1", 0.0, 0.0, 400.0, 300.0);
        let anchor = CursorAnchor::new("w1", &target.frame, &ComputerPoint { x: 50.0, y: 50.0 });
        let other = listed("w2", 0.0, 0.0, 200.0, 200.0);
        let front = track_cursor(&[other.clone(), target.clone()], &anchor).unwrap();
        assert!(front.covered);
        let behind = track_cursor(&[target, other], &anchor).unwrap();
        assert!(!behind.covered);
    }

    fn r(x: f64, y: f64, w: f64, h: f64) -> ComputerRect {
        ComputerRect {
            x,
            y,
            w,
            h,
            display_id: None,
        }
    }

    #[test]
    fn visible_center_stays_inside_the_window() {
        // TextEdit's text area: far taller than its window.
        let text = r(479.0, 299.0, 656.0, 1134.0);
        let window = r(479.0, 163.0, 656.0, 422.0);
        assert_eq!(
            visible_center(&text, std::slice::from_ref(&window)),
            Some(ComputerPoint { x: 807.0, y: 442.0 })
        );
        assert_eq!(
            visible_center(&text, &[]),
            Some(ComputerPoint { x: 807.0, y: 866.0 })
        );
        assert_eq!(visible_center(&text, &[r(0.0, 0.0, 10.0, 10.0)]), None);
    }

    #[test]
    fn tracked_cursor_is_gone_with_its_window() {
        let anchor = CursorAnchor {
            window_id: "w1".to_string(),
            dx: 0.0,
            dy: 0.0,
        };
        assert!(track_cursor(&[listed("w2", 0.0, 0.0, 10.0, 10.0)], &anchor).is_none());
    }
}
