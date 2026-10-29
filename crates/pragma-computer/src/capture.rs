//! Windows, displays, and screen capture through `xcap`, on every platform.
//!
//! `xcap` already backs the desktop's browser-tab capture, it has a real
//! implementation on macOS and Windows, and it needs no `unsafe` here. Its
//! macOS path uses the deprecated `CGWindowListCreateImage`; moving to
//! `ScreenCaptureKit` (and excluding Pragma's overlay windows by filter) is the
//! planned upgrade, behind this same module.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use image::{imageops::FilterType, DynamicImage, ImageFormat, RgbaImage};
use pragma_constants::{
    ComputerDisplay, ComputerErrorCode, ComputerImageFormat, ComputerPoint, ComputerRect,
    ComputerScreenshot,
};

use crate::{failure, ComputerResult};

const PLATFORM_TAG: &str = if cfg!(target_os = "macos") {
    "mac"
} else {
    "win"
};

/// Formats a window id for this platform.
#[must_use]
pub fn window_id(raw: u32) -> String {
    if cfg!(target_os = "macos") {
        format!("win:mac:{raw}")
    } else {
        format!("win:win:{raw:x}")
    }
}

/// Parses a window id for this platform back to the native id.
#[must_use]
pub fn parse_window_id(id: &str) -> Option<u32> {
    let rest = id.strip_prefix("win:")?;
    let (tag, raw) = rest.split_once(':')?;
    if tag != PLATFORM_TAG {
        return None;
    }
    if cfg!(target_os = "macos") {
        raw.parse().ok()
    } else {
        u32::from_str_radix(raw, 16).ok()
    }
}

/// Formats a display id for this platform.
#[must_use]
pub fn display_id(raw: u32) -> String {
    format!("display:{PLATFORM_TAG}:{raw}")
}

fn capture_error(error: impl std::fmt::Display) -> pragma_constants::ComputerFailure {
    let message = error.to_string();
    // xcap reports a missing Screen Recording grant as an empty or failed
    // image; name the permission so the caller knows what to fix.
    let mut failure = failure(
        ComputerErrorCode::Internal,
        format!("capture failed: {message}"),
    );
    failure.hint = Some(
        "Check the Screen Recording permission with `pragma-cli computer permissions`.".to_string(),
    );
    failure
}

/// Attached displays.
pub fn displays() -> ComputerResult<Vec<ComputerDisplay>> {
    let monitors = xcap::Monitor::all().map_err(capture_error)?;
    Ok(monitors
        .iter()
        .filter_map(|monitor| {
            let id = display_id(monitor.id().ok()?);
            Some(ComputerDisplay {
                frame: ComputerRect {
                    x: f64::from(monitor.x().ok()?),
                    y: f64::from(monitor.y().ok()?),
                    w: f64::from(monitor.width().ok()?),
                    h: f64::from(monitor.height().ok()?),
                    display_id: Some(id.clone()),
                },
                id,
                scale: f64::from(monitor.scale_factor().unwrap_or(1.0)),
                primary: monitor.is_primary().unwrap_or(false),
            })
        })
        .collect())
}

/// What to capture.
#[derive(Debug, Clone)]
pub enum CaptureTarget {
    Window { raw_id: u32, frame: ComputerRect },
    Display { raw_id: Option<u32> },
    Region(ComputerRect),
}

/// How to encode and where to write a capture.
#[derive(Debug, Clone)]
pub struct CaptureOutput {
    pub format: ComputerImageFormat,
    pub max_width: Option<u32>,
    pub path: Option<PathBuf>,
    pub directory: PathBuf,
    pub inline: bool,
}

/// Captures `target` and writes it out. A display or region capture leaves
/// out every window of `hide_pids`; a window capture is of one window only.
pub fn capture(
    target: &CaptureTarget,
    output: &CaptureOutput,
    hide_pids: &[u64],
) -> ComputerResult<ComputerScreenshot> {
    #[cfg(target_os = "macos")]
    let (image, frame) = if crate::macos::supports_screen_capture_kit() {
        crate::macos::capture_image(target, output.max_width, hide_pids)?
    } else {
        grab(target, hide_pids)?
    };
    #[cfg(not(target_os = "macos"))]
    let (image, frame) = grab(target, hide_pids)?;
    encode(image, &frame, output)
}

fn grab(target: &CaptureTarget, hide_pids: &[u64]) -> ComputerResult<(RgbaImage, ComputerRect)> {
    match target {
        CaptureTarget::Window { raw_id, frame } => {
            let window = xcap::Window::all()
                .map_err(capture_error)?
                .into_iter()
                .find(|window| window.id().ok() == Some(*raw_id))
                .ok_or_else(|| {
                    failure(
                        ComputerErrorCode::WindowNotFound,
                        "the window is no longer on screen",
                    )
                })?;
            if window.is_minimized().unwrap_or(false) {
                return Err(failure(
                    ComputerErrorCode::WindowMinimized,
                    "the window is minimized",
                ));
            }
            Ok((
                window.capture_image().map_err(capture_error)?,
                frame.clone(),
            ))
        }
        CaptureTarget::Display { raw_id } => {
            let monitors = xcap::Monitor::all().map_err(capture_error)?;
            let monitor = match raw_id {
                Some(id) => monitors
                    .into_iter()
                    .find(|monitor| monitor.id().ok() == Some(*id)),
                None => monitors
                    .into_iter()
                    .find(|monitor| monitor.is_primary().unwrap_or(false)),
            }
            .ok_or_else(|| failure(ComputerErrorCode::WindowNotFound, "no such display"))?;
            let frame = monitor_frame(&monitor)?;
            let mut image = monitor.capture_image().map_err(capture_error)?;
            redact(&mut image, &frame, hide_pids)?;
            Ok((image, frame))
        }
        CaptureTarget::Region(region) => {
            let monitor = xcap::Monitor::from_point(to_i32(region.x), to_i32(region.y))
                .map_err(capture_error)?;
            let display = monitor_frame(&monitor)?;
            let scale = f64::from(monitor.scale_factor().unwrap_or(1.0));
            let mut image = monitor.capture_image().map_err(capture_error)?;
            redact(&mut image, &display, hide_pids)?;
            // The monitor image is in pixels; the region is in screen units.
            let x = to_u32((region.x - display.x) * scale);
            let y = to_u32((region.y - display.y) * scale);
            let w = to_u32(region.w * scale).min(image.width().saturating_sub(x));
            let h = to_u32(region.h * scale).min(image.height().saturating_sub(y));
            if w == 0 || h == 0 {
                return Err(failure(
                    ComputerErrorCode::InvalidPayload,
                    "the region is outside its display",
                ));
            }
            let cropped = image::imageops::crop_imm(&image, x, y, w, h).to_image();
            Ok((cropped, region.clone()))
        }
    }
}

/// Paints over every on-screen window of `hide_pids` in a capture of `area`.
/// `xcap` cannot leave windows out of a monitor capture the way
/// `ScreenCaptureKit` can, so they are blanked instead: a covered part of
/// such a window is blanked too, which over-hides rather than leaks.
fn redact(image: &mut RgbaImage, area: &ComputerRect, hide_pids: &[u64]) -> ComputerResult<()> {
    if hide_pids.is_empty() || area.w <= 0.0 || area.h <= 0.0 {
        return Ok(());
    }
    // Window and monitor frames share units, whatever DPI scaling makes of
    // them, so the image's own ratio maps one onto the other.
    let scale_x = f64::from(image.width()) / area.w;
    let scale_y = f64::from(image.height()) / area.h;
    for window in xcap::Window::all().map_err(capture_error)? {
        if !window
            .pid()
            .is_ok_and(|pid| hide_pids.contains(&u64::from(pid)))
            || window.is_minimized().unwrap_or(false)
        {
            continue;
        }
        // A hidden app's window whose place is unknown cannot be blanked, so
        // the capture is refused rather than returned with it showing.
        let (Ok(x), Ok(y), Ok(w), Ok(h)) =
            (window.x(), window.y(), window.width(), window.height())
        else {
            return Err(capture_error("a protected window's frame is unknown"));
        };
        let left = to_u32((f64::from(x) - area.x) * scale_x).min(image.width());
        let top = to_u32((f64::from(y) - area.y) * scale_y).min(image.height());
        let right = to_u32((f64::from(x) + f64::from(w) - area.x) * scale_x).min(image.width());
        let bottom = to_u32((f64::from(y) + f64::from(h) - area.y) * scale_y).min(image.height());
        for py in top..bottom {
            for px in left..right {
                image.put_pixel(px, py, image::Rgba([0, 0, 0, 255]));
            }
        }
    }
    Ok(())
}

fn monitor_frame(monitor: &xcap::Monitor) -> ComputerResult<ComputerRect> {
    Ok(ComputerRect {
        x: f64::from(monitor.x().map_err(capture_error)?),
        y: f64::from(monitor.y().map_err(capture_error)?),
        w: f64::from(monitor.width().map_err(capture_error)?),
        h: f64::from(monitor.height().map_err(capture_error)?),
        display_id: monitor.id().ok().map(display_id),
    })
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn to_u32(value: f64) -> u32 {
    value.max(0.0).round() as u32
}

#[allow(clippy::cast_possible_truncation)]
fn to_i32(value: f64) -> i32 {
    value.round() as i32
}

/// Encodes an image, downscaling to `max_width`, and writes it out.
pub fn encode(
    image: RgbaImage,
    frame: &ComputerRect,
    output: &CaptureOutput,
) -> ComputerResult<ComputerScreenshot> {
    if image.width() == 0 || image.height() == 0 {
        return Err(capture_error("the captured image is empty"));
    }
    let mut image = DynamicImage::ImageRgba8(image);
    if let Some(max) = output
        .max_width
        .filter(|max| *max > 0 && image.width() > *max)
    {
        let height =
            u32::try_from(u64::from(image.height()) * u64::from(max) / u64::from(image.width()))
                .unwrap_or(1)
                .max(1);
        image = image.resize_exact(max, height, FilterType::Triangle);
    }
    let (format, extension) = match output.format {
        ComputerImageFormat::Png => (ImageFormat::Png, "png"),
        ComputerImageFormat::Jpeg => {
            // JPEG has no alpha channel.
            image = DynamicImage::ImageRgb8(image.to_rgb8());
            (ImageFormat::Jpeg, "jpg")
        }
    };
    let mut bytes = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut bytes), format)
        .map_err(|error| {
            failure(
                ComputerErrorCode::Internal,
                format!("encode failed: {error}"),
            )
        })?;
    let id = format!("shot_{}", uuid::Uuid::new_v4().simple());
    let path = match &output.path {
        Some(path) => path.clone(),
        None => output.directory.join(format!("{id}.{extension}")),
    };
    write_private(&path, &bytes)?;
    let width = image.width();
    let scale = if frame.w > 0.0 {
        f64::from(width) / frame.w
    } else {
        1.0
    };
    Ok(ComputerScreenshot {
        id,
        path: path.to_string_lossy().into_owned(),
        width: u64::from(width),
        height: u64::from(image.height()),
        origin: ComputerPoint {
            x: frame.x,
            y: frame.y,
        },
        scale,
        format: output.format,
        bytes: bytes.len() as u64,
        base64: output
            .inline
            .then(|| base64::engine::general_purpose::STANDARD.encode(&bytes)),
    })
}

fn write_private(path: &Path, bytes: &[u8]) -> ComputerResult<()> {
    let io = |error: std::io::Error| {
        failure(
            ComputerErrorCode::Internal,
            format!("write {}: {error}", path.display()),
        )
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let mut file = pragma_platform::perms::create_private_file(path).map_err(io)?;
    std::io::Write::write_all(&mut file, bytes).map_err(io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids_round_trip() {
        assert_eq!(parse_window_id(&window_id(18233)), Some(18233));
        assert_eq!(parse_window_id("win:other:1"), None);
        assert_eq!(parse_window_id("nope"), None);
    }

    #[test]
    fn encode_downscales_and_records_scale() {
        let dir = tempfile::tempdir().unwrap();
        let image = RgbaImage::from_pixel(400, 200, image::Rgba([10, 20, 30, 255]));
        let frame = ComputerRect {
            x: 100.0,
            y: 50.0,
            w: 200.0,
            h: 100.0,
            display_id: None,
        };
        let shot = encode(
            image,
            &frame,
            &CaptureOutput {
                format: ComputerImageFormat::Jpeg,
                max_width: Some(100),
                path: None,
                directory: dir.path().to_path_buf(),
                inline: true,
            },
        )
        .unwrap();
        assert_eq!(shot.width, 100);
        assert_eq!(shot.height, 50);
        assert!((shot.scale - 0.5).abs() < f64::EPSILON);
        assert!((shot.origin.x - 100.0).abs() < f64::EPSILON);
        assert!(Path::new(&shot.path).exists());
        assert!(shot.base64.is_some());
    }
}
