//! Synthetic input through `CGEvent`, posted at the HID tap.
//!
//! This is the foreground path, for drags and for clicks the background path
//! (`background`) cannot address: HID-tap events move the real cursor and go
//! to whatever is focused, so the callers activate the target first and
//! verify it is still frontmost. Events
//! come from a *private* event source: the user's held modifiers do not leak
//! into ours, and ours do not show up in the HID system state that takeover
//! detection reads.
//!
//! The key-code tables are shared with `background`, which sends every key:
//! chords use ANSI virtual key codes with the character attached, so menu key
//! equivalents match on the character even on other layouts.

use std::time::Duration;

use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventType, CGMouseButton, CGScrollEventUnit,
};
use pragma_constants::{ComputerErrorCode, ComputerMouseButton};
use pragma_core::computer::{Key, Modifier, NamedKey};

use crate::{failure, ComputerResult, StopFlag};

/// Gap between synthetic events, so apps see distinct events.
const EVENT_GAP: Duration = Duration::from_millis(8);

pub(super) fn source() -> Option<objc2_core_foundation::CFRetained<CGEventSource>> {
    CGEventSource::new(CGEventSourceStateID::Private)
}

fn post(event: &CGEvent) {
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(event));
    std::thread::sleep(EVENT_GAP);
}

pub(super) fn event_failed() -> pragma_constants::ComputerFailure {
    failure(
        ComputerErrorCode::Internal,
        "could not create a synthetic input event",
    )
}

/// The current pointer location.
pub fn pointer_location() -> Option<CGPoint> {
    let event = CGEvent::new(None)?;
    Some(CGEvent::location(Some(&event)))
}

/// Moves the pointer to `point`.
pub fn move_to(point: CGPoint) -> ComputerResult<()> {
    let source = source();
    let event = CGEvent::new_mouse_event(
        source.as_deref(),
        CGEventType::MouseMoved,
        point,
        CGMouseButton::Left,
    )
    .ok_or_else(event_failed)?;
    post(&event);
    Ok(())
}

pub(super) fn button_events(
    button: ComputerMouseButton,
) -> (CGEventType, CGEventType, CGMouseButton) {
    match button {
        ComputerMouseButton::Left => (
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
            CGMouseButton::Left,
        ),
        ComputerMouseButton::Right => (
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
            CGMouseButton::Right,
        ),
        ComputerMouseButton::Middle => (
            CGEventType::OtherMouseDown,
            CGEventType::OtherMouseUp,
            CGMouseButton::Center,
        ),
    }
}

/// Clicks `count` times at `point` with `modifiers` held.
pub fn click(
    stop: &StopFlag,
    point: CGPoint,
    button: ComputerMouseButton,
    count: u32,
    modifiers: &[Modifier],
) -> ComputerResult<()> {
    let (down, up, cg_button) = button_events(button);
    let flags = flags_for(modifiers);
    let source = source();
    move_to(point)?;
    for click in 1..=count.max(1) {
        stop.check()?;
        for kind in [down, up] {
            let event = CGEvent::new_mouse_event(source.as_deref(), kind, point, cg_button)
                .ok_or_else(event_failed)?;
            CGEvent::set_integer_value_field(
                Some(&event),
                CGEventField::MouseEventClickState,
                i64::from(click),
            );
            CGEvent::set_flags(Some(&event), flags);
            post(&event);
        }
    }
    Ok(())
}

/// Presses at `from`, moves to `to` in steps, and releases.
pub fn drag(
    stop: &StopFlag,
    from: CGPoint,
    to: CGPoint,
    duration: Duration,
    modifiers: &[Modifier],
) -> ComputerResult<()> {
    let flags = flags_for(modifiers);
    let source = source();
    move_to(from)?;
    let down = CGEvent::new_mouse_event(
        source.as_deref(),
        CGEventType::LeftMouseDown,
        from,
        CGMouseButton::Left,
    )
    .ok_or_else(event_failed)?;
    CGEvent::set_flags(Some(&down), flags);
    post(&down);
    let steps: u32 = 24;
    let pause = duration / steps;
    let mut result = Ok(());
    for step in 1..=steps {
        if let Err(error) = stop.check() {
            result = Err(error);
            break;
        }
        let t = f64::from(step) / f64::from(steps);
        let point = CGPoint {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
        };
        let event = CGEvent::new_mouse_event(
            source.as_deref(),
            CGEventType::LeftMouseDragged,
            point,
            CGMouseButton::Left,
        )
        .ok_or_else(event_failed)?;
        CGEvent::set_flags(Some(&event), flags);
        post(&event);
        std::thread::sleep(pause);
    }
    // Always release, even after a stop, so no button is left held down.
    let release_at = if result.is_ok() {
        to
    } else {
        pointer_location().unwrap_or(to)
    };
    let up = CGEvent::new_mouse_event(
        source.as_deref(),
        CGEventType::LeftMouseUp,
        release_at,
        CGMouseButton::Left,
    )
    .ok_or_else(event_failed)?;
    post(&up);
    result
}

/// Scrolls by `lines` (positive is up/left) at the current pointer location.
pub fn scroll(stop: &StopFlag, vertical: i32, horizontal: i32) -> ComputerResult<()> {
    let source = source();
    // One event per line keeps the stop responsive on long scrolls.
    let count = vertical.unsigned_abs().max(horizontal.unsigned_abs());
    for _ in 0..count {
        stop.check()?;
        let event = CGEvent::new_scroll_wheel_event2(
            source.as_deref(),
            CGScrollEventUnit::Line,
            2,
            vertical.signum(),
            horizontal.signum(),
            0,
        )
        .ok_or_else(event_failed)?;
        post(&event);
    }
    Ok(())
}

pub(super) fn flags_for(modifiers: &[Modifier]) -> CGEventFlags {
    let mut flags = CGEventFlags::empty();
    for modifier in modifiers {
        flags |= match modifier {
            Modifier::Ctrl => CGEventFlags::MaskControl,
            Modifier::Alt => CGEventFlags::MaskAlternate,
            Modifier::Shift => CGEventFlags::MaskShift,
            Modifier::Cmd => CGEventFlags::MaskCommand,
        };
    }
    flags
}

/// The ANSI virtual key code for a key, plus the character to attach.
pub(super) fn key_code(key: Key) -> Option<(u16, Option<char>)> {
    match key {
        Key::Named(named) => Some((named_code(named)?, None)),
        Key::Char(c) => Some((char_code(c)?, Some(c))),
    }
}

fn named_code(key: NamedKey) -> Option<u16> {
    Some(match key {
        NamedKey::Enter => 0x24,
        NamedKey::Tab => 0x30,
        NamedKey::Space => 0x31,
        NamedKey::Backspace => 0x33,
        NamedKey::Escape => 0x35,
        NamedKey::Delete => 0x75,
        NamedKey::Home => 0x73,
        NamedKey::End => 0x77,
        NamedKey::PageUp => 0x74,
        NamedKey::PageDown => 0x79,
        NamedKey::Left => 0x7B,
        NamedKey::Right => 0x7C,
        NamedKey::Down => 0x7D,
        NamedKey::Up => 0x7E,
        NamedKey::F(n) => match n {
            1 => 0x7A,
            2 => 0x78,
            3 => 0x63,
            4 => 0x76,
            5 => 0x60,
            6 => 0x61,
            7 => 0x62,
            8 => 0x64,
            9 => 0x65,
            10 => 0x6D,
            11 => 0x67,
            12 => 0x6F,
            _ => return None,
        },
    })
}

fn char_code(c: char) -> Option<u16> {
    Some(match c {
        'a' => 0x00,
        's' => 0x01,
        'd' => 0x02,
        'f' => 0x03,
        'h' => 0x04,
        'g' => 0x05,
        'z' => 0x06,
        'x' => 0x07,
        'c' => 0x08,
        'v' => 0x09,
        'b' => 0x0B,
        'q' => 0x0C,
        'w' => 0x0D,
        'e' => 0x0E,
        'r' => 0x0F,
        'y' => 0x10,
        't' => 0x11,
        '1' => 0x12,
        '2' => 0x13,
        '3' => 0x14,
        '4' => 0x15,
        '6' => 0x16,
        '5' => 0x17,
        '=' | '+' => 0x18,
        '9' => 0x19,
        '7' => 0x1A,
        '-' => 0x1B,
        '8' => 0x1C,
        '0' => 0x1D,
        ']' => 0x1E,
        'o' => 0x1F,
        'u' => 0x20,
        '[' => 0x21,
        'i' => 0x22,
        'p' => 0x23,
        'l' => 0x25,
        'j' => 0x26,
        '\'' => 0x27,
        'k' => 0x28,
        ';' => 0x29,
        '\\' => 0x2A,
        ',' => 0x2B,
        '/' => 0x2C,
        'n' => 0x2D,
        'm' => 0x2E,
        '.' => 0x2F,
        '`' => 0x32,
        _ => return None,
    })
}

/// Seconds since the most recent physical event of any of `kinds`, from the
/// HID system state (which our private-source events never touch).
fn seconds_since(kinds: &[CGEventType]) -> f64 {
    kinds
        .iter()
        .map(|kind| {
            CGEventSource::seconds_since_last_event_type(
                CGEventSourceStateID::HIDSystemState,
                *kind,
            )
        })
        .fold(f64::INFINITY, f64::min)
}

/// Seconds since the user last pressed a key.
pub fn seconds_since_key_press() -> f64 {
    seconds_since(&[CGEventType::KeyDown])
}

/// Seconds since the user last clicked, dragged, or scrolled. Moving the
/// pointer alone is deliberately not counted.
pub fn seconds_since_pointer_use() -> f64 {
    seconds_since(&[
        CGEventType::LeftMouseDown,
        CGEventType::RightMouseDown,
        CGEventType::OtherMouseDown,
        CGEventType::LeftMouseDragged,
        CGEventType::RightMouseDragged,
        CGEventType::OtherMouseDragged,
        CGEventType::ScrollWheel,
    ])
}
