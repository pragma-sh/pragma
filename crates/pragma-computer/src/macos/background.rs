//! Background input: events addressed to one process, so the target app is
//! never activated, its window never raised, and the user's pointer and key
//! window are left alone. The user keeps working while the agent does.
//!
//! Pointer events carry the target window's id in the routing fields and its
//! screen point as the window location, and go out through `SLEventPostToPid`
//! (see `ffi`'s `SkyLight` section). Before a click the window is made
//! AppKit-active with one focus-without-raise record, and a `mouseMoved`
//! primes `AppKit`'s tracking state, without which a background control ignores
//! the down. Keys go to the app's focused window, so callers focus the target
//! element through Accessibility first.
//!
//! Drags are not delivered this way (`AppKit`'s drag loops track the real
//! pointer); callers activate the target for those.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, CGScrollEventUnit};
use pragma_constants::{ComputerErrorCode, ComputerMouseButton};
use pragma_core::computer::{Chord, Modifier};

use super::ffi;
use super::input::{button_events, event_failed, flags_for, key_code, source};
use crate::{failure, ComputerResult, StopFlag};

/// Settle time after the focus record, so `AppKit` updates its routing first.
const FOCUS_SETTLE: Duration = Duration::from_millis(50);
/// Down→up gap: a button's tracking loop polls for the up and can miss one
/// that arrives too soon.
const PRESS_GAP: Duration = Duration::from_millis(28);
/// Gap between clicks of a multi-click.
const CLICK_GAP: Duration = Duration::from_millis(80);
/// Gap between key events.
const KEY_GAP: Duration = Duration::from_millis(8);

// Raw event fields. 40 is the public target-pid field (Chromium filters on
// it); 51 is the window number AppKit's `NSEvent` reads; 91 and 92 are the
// window under the pointer (and the one that can handle the event); 58 groups
// the events of one gesture.
const FIELD_CLICK_STATE: u32 = 1;
const FIELD_BUTTON_NUMBER: u32 = 3;
const FIELD_TARGET_PID: u32 = 40;
const FIELD_WINDOW_NUMBER: u32 = 51;
const FIELD_GESTURE_ID: u32 = 58;
const FIELD_WINDOW_UNDER_POINTER: u32 = 91;
const FIELD_WINDOW_THAT_CAN_HANDLE: u32 = 92;

/// When this helper last posted a key, and a pointer event. Events posted to a
/// pid may be counted in the HID system state takeover detection reads, so
/// anything no newer than our own last post is not attributed to the user.
static LAST_KEY: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_POINTER: Mutex<Option<Instant>> = Mutex::new(None);

fn mark(slot: &Mutex<Option<Instant>>) {
    if let Ok(mut last) = slot.lock() {
        *last = Some(Instant::now());
    }
}

fn since(slot: &Mutex<Option<Instant>>) -> Option<f64> {
    slot.lock()
        .ok()
        .and_then(|last| last.map(|at| at.elapsed().as_secs_f64()))
}

/// Seconds since this helper last posted a key in the background.
pub fn seconds_since_own_key() -> Option<f64> {
    since(&LAST_KEY)
}

/// Seconds since this helper last posted a pointer event in the background.
pub fn seconds_since_own_pointer() -> Option<f64> {
    since(&LAST_POINTER)
}

/// Whether background delivery can be used right now.
pub fn available() -> bool {
    ffi::background_input_available()
}

/// One pointer gesture aimed at a window of a background app.
#[derive(Clone, Copy)]
pub struct Target {
    pub pid: i32,
    pub window: u32,
    pub point: CGPoint,
    /// The window's top-left corner, in screen points.
    pub origin: CGPoint,
    /// The window's height, in points.
    pub height: f64,
}

// TEMPORARY(background-input tuning): `PRAGMA_COMPUTER_BG` picks the click
// recipe while it is measured on a granted helper, so variants need no
// rebuild (each rebuild resets the helper's TCC grants). Removed once tuned.
// Temporary knob; removed with the env var.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug)]
struct Variant {
    location: String,
    route: String,
    primer: bool,
    touch: bool,
    focus: bool,
    hid_source: bool,
}

/// TEMPORARY(background-input tuning): traces decisions to stderr while
/// `PRAGMA_COMPUTER_DEBUG` is set.
pub fn trace(message: impl FnOnce() -> String) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ON.get_or_init(|| std::env::var_os("PRAGMA_COMPUTER_DEBUG").is_some()) {
        eprintln!("[bg] {}", message());
    }
}

fn variant() -> &'static Variant {
    static VARIANT: std::sync::OnceLock<Variant> = std::sync::OnceLock::new();
    VARIANT.get_or_init(|| {
        let raw = std::env::var("PRAGMA_COMPUTER_BG").unwrap_or_default();
        let get = |key: &str, default: &str| {
            raw.split(',')
                .find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='))
                .unwrap_or(default)
                .to_string()
        };
        Variant {
            location: get("loc", "local"),
            route: get("route", "sky"),
            primer: get("primer", "off") == "on",
            touch: get("touch", "off") == "on",
            focus: get("focus", "on") == "on",
            hid_source: get("source", "private") == "hid",
        }
    })
}

fn variant_source() -> Option<objc2_core_foundation::CFRetained<objc2_core_graphics::CGEventSource>>
{
    if variant().hid_source {
        objc2_core_graphics::CGEventSource::new(
            objc2_core_graphics::CGEventSourceStateID::HIDSystemState,
        )
    } else {
        source()
    }
}

fn post_pointer(pid: i32, event: &CGEvent) {
    match variant().route.as_str() {
        "public" => CGEvent::post_to_pid(pid, Some(event)),
        _ => ffi::post_to_pid(pid, event, false),
    }
    mark(&LAST_POINTER);
}

fn post_key(pid: i32, event: &CGEvent) {
    ffi::post_to_pid(pid, event, true);
    mark(&LAST_KEY);
}

fn gesture_id() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| i64::from(elapsed.subsec_nanos()))
}

fn stamp(event: &CGEvent, target: &Target, gesture: i64, flags: CGEventFlags) {
    let window = i64::from(target.window);
    ffi::set_event_field(event, FIELD_TARGET_PID, i64::from(target.pid));
    ffi::set_event_field(event, FIELD_WINDOW_NUMBER, window);
    ffi::set_event_field(event, FIELD_WINDOW_UNDER_POINTER, window);
    ffi::set_event_field(event, FIELD_WINDOW_THAT_CAN_HANDLE, window);
    ffi::set_event_field(event, FIELD_GESTURE_ID, gesture);
    let local_x = target.point.x - target.origin.x;
    let local_y = target.point.y - target.origin.y;
    match variant().location.as_str() {
        "screen" => ffi::set_window_location(event, target.point),
        "local" => ffi::set_window_location(
            event,
            CGPoint {
                x: local_x,
                y: local_y,
            },
        ),
        "flipped" => ffi::set_window_location(
            event,
            CGPoint {
                x: local_x,
                y: target.height - local_y,
            },
        ),
        _ => {}
    }
    if variant().touch {
        ffi::set_event_field(event, 7, 3);
    }
    CGEvent::set_flags(Some(event), flags);
}

fn pointer_event(
    kind: CGEventType,
    target: &Target,
    button: CGMouseButton,
    gesture: i64,
    flags: CGEventFlags,
) -> ComputerResult<objc2_core_foundation::CFRetained<CGEvent>> {
    let source = variant_source();
    let event = CGEvent::new_mouse_event(source.as_deref(), kind, target.point, button)
        .ok_or_else(event_failed)?;
    stamp(&event, target, gesture, flags);
    Ok(event)
}

/// Makes the target window AppKit-active without raising it.
///
/// # Errors
///
/// `targetChanged` when the Window Server refused the focus record; the
/// caller falls back to activating the app.
pub fn prepare(target: &Target) -> ComputerResult<()> {
    if !variant().focus {
        return Ok(());
    }
    let focused = ffi::focus_without_raise(target.pid, target.window);
    trace(|| {
        format!(
            "focus record pid={} window={} ok={focused} invalid_connection={} variant={:?}",
            target.pid,
            target.window,
            ffi::connection_invalid(),
            variant()
        )
    });
    if !focused {
        return Err(failure(
            ComputerErrorCode::TargetChanged,
            "the window could not be focused in the background",
        ));
    }
    std::thread::sleep(FOCUS_SETTLE);
    Ok(())
}

/// Clicks `count` times at the target point with `modifiers` held, without
/// moving the user's pointer.
///
/// # Errors
///
/// A stop, or an event that could not be created.
pub fn click(
    stop: &StopFlag,
    target: &Target,
    button: ComputerMouseButton,
    count: u32,
    modifiers: &[Modifier],
) -> ComputerResult<()> {
    let (down, up, cg_button) = button_events(button);
    let flags = flags_for(modifiers);
    let gesture = gesture_id();
    let moved = pointer_event(
        CGEventType::MouseMoved,
        target,
        CGMouseButton::Left,
        gesture,
        flags,
    )?;
    post_pointer(target.pid, &moved);
    std::thread::sleep(Duration::from_millis(15));
    if variant().primer {
        let off_screen = Target {
            point: CGPoint { x: -1.0, y: -1.0 },
            ..*target
        };
        for kind in [CGEventType::LeftMouseDown, CGEventType::LeftMouseUp] {
            let event = pointer_event(kind, &off_screen, CGMouseButton::Left, gesture, flags)?;
            ffi::set_event_field(&event, FIELD_CLICK_STATE, 1);
            post_pointer(target.pid, &event);
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let button_number = match button {
        ComputerMouseButton::Left => 0,
        ComputerMouseButton::Right => 1,
        ComputerMouseButton::Middle => 2,
    };
    for click in 1..=count.max(1) {
        stop.check()?;
        for (kind, pause) in [(down, PRESS_GAP), (up, Duration::ZERO)] {
            let event = pointer_event(kind, target, cg_button, gesture, flags)?;
            ffi::set_event_field(&event, FIELD_CLICK_STATE, i64::from(click));
            ffi::set_event_field(&event, FIELD_BUTTON_NUMBER, button_number);
            post_pointer(target.pid, &event);
            std::thread::sleep(pause);
        }
        if click < count {
            std::thread::sleep(CLICK_GAP);
        }
    }
    Ok(())
}

/// Scrolls by `lines` (positive is up/left) at the target point.
///
/// # Errors
///
/// A stop, or an event that could not be created.
pub fn scroll(
    stop: &StopFlag,
    target: &Target,
    vertical: i32,
    horizontal: i32,
) -> ComputerResult<()> {
    let gesture = gesture_id();
    let moved = pointer_event(
        CGEventType::MouseMoved,
        target,
        CGMouseButton::Left,
        gesture,
        CGEventFlags::empty(),
    )?;
    post_pointer(target.pid, &moved);
    let count = vertical.unsigned_abs().max(horizontal.unsigned_abs());
    for _ in 0..count {
        stop.check()?;
        let source = source();
        let event = CGEvent::new_scroll_wheel_event2(
            source.as_deref(),
            CGScrollEventUnit::Line,
            2,
            vertical.signum(),
            horizontal.signum(),
            0,
        )
        .ok_or_else(event_failed)?;
        CGEvent::set_location(Some(&event), target.point);
        stamp(&event, target, gesture, CGEventFlags::empty());
        post_pointer(target.pid, &event);
        std::thread::sleep(Duration::from_millis(30));
    }
    Ok(())
}

/// Presses one chord in `pid`'s focused window.
///
/// Every key carries the authentication message, which both satisfies
/// Chromium-based apps and keeps the event on the direct, pid-only path.
/// Menu shortcuts are pressed as menu items instead (`AppKit` drops key
/// equivalents for a background app).
///
/// # Errors
///
/// A key with no macOS key code, or an event that could not be created.
pub fn press(pid: i32, chord: &Chord) -> ComputerResult<()> {
    let (code, character) = key_code(chord.key).ok_or_else(|| {
        failure(
            ComputerErrorCode::InvalidPayload,
            "that key has no macOS key code",
        )
    })?;
    let flags = flags_for(&chord.modifiers);
    for down in [true, false] {
        let source = source();
        let event =
            CGEvent::new_keyboard_event(source.as_deref(), code, down).ok_or_else(event_failed)?;
        CGEvent::set_flags(Some(&event), flags);
        if let Some(character) = character {
            let mut buffer = [0u16; 2];
            ffi::set_unicode(&event, character.encode_utf16(&mut buffer));
        }
        post_key(pid, &event);
        std::thread::sleep(KEY_GAP);
    }
    Ok(())
}

/// Types `text` into `pid`'s focused element, one character at a time
/// (Chromium reads one character per synthetic key). Newlines and tabs are
/// sent as the real Return and Tab keys.
///
/// # Errors
///
/// A stop, or an event that could not be created.
pub fn type_text(stop: &StopFlag, pid: i32, text: &str) -> ComputerResult<()> {
    const RETURN: u16 = 0x24;
    const TAB: u16 = 0x30;
    for character in text.chars() {
        stop.check()?;
        let (code, payload) = match character {
            '\n' | '\r' => (RETURN, false),
            '\t' => (TAB, false),
            _ => (0, true),
        };
        for down in [true, false] {
            let source = source();
            let event = CGEvent::new_keyboard_event(source.as_deref(), code, down)
                .ok_or_else(event_failed)?;
            if payload {
                let mut buffer = [0u16; 2];
                ffi::set_unicode(&event, character.encode_utf16(&mut buffer));
            }
            // No flags: Chromium infers Shift from an uppercase character's
            // flags and leaks it into the next one.
            CGEvent::set_flags(Some(&event), CGEventFlags::empty());
            post_key(pid, &event);
            std::thread::sleep(KEY_GAP);
        }
    }
    Ok(())
}
