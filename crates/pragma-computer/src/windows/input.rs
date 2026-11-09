//! Physical input, with a foreground check and stop boundary before every down event.
use super::ffi;
use crate::{failure, ComputerResult, Context};
use pragma_constants::{ComputerErrorCode, ComputerMouseButton, ComputerPoint};
use pragma_core::computer::{parse_chord, ChordPlatform, Key, Modifier, NamedKey};
use std::time::Duration;
fn guard(ctx: &Context, pid: u64) -> ComputerResult<()> {
    ctx.stop.check()?;
    if ffi::foreground_pid() != Some(pid) {
        return Err(failure(
            ComputerErrorCode::TargetChanged,
            "The foreground application changed",
        ));
    }
    Ok(())
}
fn vk(key: Key) -> ComputerResult<u16> {
    Ok(match key {
        Key::Char(c) if c.is_ascii_alphanumeric() => c.to_ascii_uppercase() as u16,
        Key::Char(_) => {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "Use Unicode text input for this character",
            ))
        }
        Key::Named(key) => match key {
            NamedKey::Enter => 0x0d,
            NamedKey::Escape => 0x1b,
            NamedKey::Tab => 9,
            NamedKey::Space => 0x20,
            NamedKey::Backspace => 8,
            NamedKey::Delete => 0x2e,
            NamedKey::Up => 0x26,
            NamedKey::Down => 0x28,
            NamedKey::Left => 0x25,
            NamedKey::Right => 0x27,
            NamedKey::Home => 0x24,
            NamedKey::End => 0x23,
            NamedKey::PageUp => 0x21,
            NamedKey::PageDown => 0x22,
            NamedKey::F(n) => 0x70 + u16::from(n.saturating_sub(1)),
        },
    })
}
fn modifier(m: Modifier) -> u16 {
    match m {
        Modifier::Ctrl => 0x11,
        Modifier::Alt => 0x12,
        Modifier::Shift => 0x10,
        Modifier::Cmd => 0x5b,
    }
}
struct Held(Vec<u16>);
impl Drop for Held {
    fn drop(&mut self) {
        for key in self.0.iter().rev() {
            let _ = ffi::key(*key, 0, false, true);
        }
    }
}
pub fn chord(ctx: &Context, pid: u64, text: &str) -> ComputerResult<()> {
    let chord = parse_chord(text, ChordPlatform::Other)
        .map_err(|message| failure(ComputerErrorCode::InvalidPayload, message))?;
    let mut held = Held(vec![]);
    for m in chord.modifiers {
        guard(ctx, pid)?;
        let key = modifier(m);
        ffi::key(key, 0, false, false)?;
        held.0.push(key);
    }
    guard(ctx, pid)?;
    let key = vk(chord.key)?;
    ffi::key(key, 0, false, false)?;
    // Always send the release even after a stop: never leave a key held down.
    ffi::key(key, 0, false, true)?;
    std::thread::sleep(Duration::from_millis(8));
    Ok(())
}
pub fn text(ctx: &Context, pid: u64, text: &str) -> ComputerResult<()> {
    for unit in text.encode_utf16() {
        guard(ctx, pid)?;
        ffi::key(0, unit, true, false)?;
        ffi::key(0, unit, true, true)?;
        std::thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}
pub fn click(
    ctx: &Context,
    pid: u64,
    point: &ComputerPoint,
    button: ComputerMouseButton,
    count: u64,
) -> ComputerResult<()> {
    guard(ctx, pid)?;
    ffi::move_to(point)?;
    for _ in 0..count.min(3) {
        guard(ctx, pid)?;
        ffi::button(button, false)?;
        ffi::button(button, true)?;
        std::thread::sleep(Duration::from_millis(35));
    }
    Ok(())
}
pub fn drag(
    ctx: &Context,
    pid: u64,
    from: &ComputerPoint,
    to: &ComputerPoint,
    duration: u64,
) -> ComputerResult<()> {
    guard(ctx, pid)?;
    ffi::move_to(from)?;
    ffi::button(ComputerMouseButton::Left, false)?;
    let result = (|| {
        for step in 1..=30 {
            guard(ctx, pid)?;
            let t = f64::from(step) / 30.0;
            ffi::move_to(&ComputerPoint {
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t,
            })?;
            std::thread::sleep(Duration::from_millis(duration.min(10000) / 30));
        }
        Ok(())
    })();
    let released = ffi::button(ComputerMouseButton::Left, true);
    result.and(released)
}
pub fn move_to(ctx: &Context, pid: u64, point: &ComputerPoint) -> ComputerResult<()> {
    guard(ctx, pid)?;
    ffi::move_to(point)
}
pub fn scroll(ctx: &Context, pid: u64, amount: i32, horizontal: bool) -> ComputerResult<()> {
    guard(ctx, pid)?;
    ffi::scroll(amount, horizontal)
}

/// Hold only caller-requested modifiers and release them on every exit path.
pub fn with_modifiers(
    ctx: &Context,
    pid: u64,
    names: &[String],
    action: impl FnOnce() -> ComputerResult<()>,
) -> ComputerResult<()> {
    let mut held = Held(vec![]);
    for name in names {
        let parsed = parse_chord(&format!("{name}+a"), ChordPlatform::Other)
            .map_err(|e| failure(ComputerErrorCode::InvalidPayload, e))?;
        if parsed.modifiers.len() != 1 {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "Expected one modifier name",
            ));
        }
        guard(ctx, pid)?;
        let key = modifier(parsed.modifiers[0]);
        ffi::key(key, 0, false, false)?;
        held.0.push(key);
    }
    action()
}
