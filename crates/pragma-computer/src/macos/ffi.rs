//! The only `unsafe` in the macOS backend: thin, safe wrappers over the
//! Accessibility (`AXUIElement`) C API, the one `CGEvent` call that takes a
//! raw buffer, and the private `SkyLight` calls behind background input.
//!
//! This is the second documented exception to the workspace's `unsafe_code`
//! deny (the first is `pragma-platform`'s `dock` seam), approved for the
//! computer-use FFI modules. The bindings mark every AX call `unsafe` because
//! they take out-pointers; each block below states why its pointer is valid.
//! Everything above this module is safe code.

#![allow(unsafe_code)]

use std::ptr::NonNull;

use objc2_application_services::{
    AXError, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType, CGPoint, CGSize,
};
use objc2_core_graphics::CGEvent;

/// A retained accessibility element.
pub type Element = CFRetained<AXUIElement>;

/// The application element for `pid`.
pub fn application(pid: i32) -> Element {
    // SAFETY: `AXUIElementCreateApplication` accepts any pid; for a pid with
    // no process it returns an element whose calls fail with an error code.
    unsafe { AXUIElement::new_application(pid) }
}

/// The system-wide element, used for hit-testing and the focused element.
pub fn system_wide() -> Element {
    // SAFETY: takes no arguments and always returns a valid element.
    unsafe { AXUIElement::new_system_wide() }
}

/// Bounds every message to `element`'s app, so a hung app cannot hang us.
pub fn set_timeout(element: &AXUIElement, seconds: f32) {
    // SAFETY: plain value argument on a valid element.
    let _ = unsafe { element.set_messaging_timeout(seconds) };
}

/// Copies one attribute's value.
pub fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let name = CFString::from_str(name);
    let mut value: *const CFType = std::ptr::null();
    // SAFETY: `value` is a live local the call writes a +1 (Copy-rule)
    // reference into on success; it is not read unless the call succeeded.
    let error = unsafe { element.copy_attribute_value(&name, NonNull::from(&mut value)) };
    if error != AXError::Success {
        return None;
    }
    let value = NonNull::new(value.cast_mut())?;
    // SAFETY: on success the reference is owned by us (Copy rule), so
    // `from_raw` takes over exactly that one retain.
    Some(unsafe { CFRetained::from_raw(value) })
}

/// A string attribute.
pub fn string(element: &AXUIElement, name: &str) -> Option<String> {
    let value = attribute(element, name)?;
    value.downcast_ref::<CFString>().map(ToString::to_string)
}

/// An integer attribute (`AXMenuItemCmdModifiers`).
pub fn integer(element: &AXUIElement, name: &str) -> Option<i64> {
    let value = attribute(element, name)?;
    value
        .downcast_ref::<objc2_core_foundation::CFNumber>()
        .and_then(objc2_core_foundation::CFNumber::as_i64)
}

/// A boolean attribute.
pub fn boolean(element: &AXUIElement, name: &str) -> Option<bool> {
    let value = attribute(element, name)?;
    value.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool)
}

/// An element-valued attribute (`AXFocusedWindow`, `AXFocusedUIElement`).
pub fn element(element: &AXUIElement, name: &str) -> Option<Element> {
    attribute(element, name)?.downcast::<AXUIElement>().ok()
}

/// An array-of-elements attribute (`AXChildren`, `AXWindows`).
pub fn elements(element: &AXUIElement, name: &str) -> Vec<Element> {
    let Some(value) = attribute(element, name) else {
        return Vec::new();
    };
    let Ok(array) = value.downcast::<CFArray>() else {
        return Vec::new();
    };
    // SAFETY: a `CFArray` always holds CF objects; viewing its items as
    // `CFType` claims nothing more, and each is downcast before use.
    let array: CFRetained<CFArray<CFType>> = unsafe { CFRetained::cast_unchecked(array) };
    (0..array.len())
        .filter_map(|index| array.get(index))
        .filter_map(|item| item.downcast::<AXUIElement>().ok())
        .collect()
}

fn ax_value<T: Default>(element: &AXUIElement, name: &str, kind: AXValueType) -> Option<T> {
    let value = attribute(element, name)?;
    let value = value.downcast_ref::<AXValue>()?;
    let mut out = T::default();
    // SAFETY: `kind` names the struct `T` is (CGPoint for kAXValueCGPointType,
    // CGSize for kAXValueCGSizeType); AXValueGetValue checks the stored type
    // matches and writes only `size_of::<T>()` bytes into `out` when it does.
    let ok = unsafe { value.value(kind, NonNull::from(&mut out).cast()) };
    ok.then_some(out)
}

/// `AXPosition`, in global top-left-origin points.
pub fn position(element: &AXUIElement) -> Option<CGPoint> {
    ax_value(element, "AXPosition", AXValueType::CGPoint)
}

/// `AXSize`, in points.
pub fn size(element: &AXUIElement) -> Option<CGSize> {
    ax_value(element, "AXSize", AXValueType::CGSize)
}

/// The element's available actions (`AXPress`, `AXShowMenu`, …).
pub fn actions(element: &AXUIElement) -> Vec<String> {
    let mut names: *const CFArray = std::ptr::null();
    // SAFETY: `names` is a live local out-pointer, read only on success.
    let error = unsafe { element.copy_action_names(NonNull::from(&mut names)) };
    if error != AXError::Success {
        return Vec::new();
    }
    let Some(names) = NonNull::new(names.cast_mut()) else {
        return Vec::new();
    };
    // SAFETY: the Copy-rule result is ours to release, and action names are
    // documented to be an array of CFStrings (each is still downcast).
    let names: CFRetained<CFArray<CFType>> =
        unsafe { CFRetained::cast_unchecked(CFRetained::from_raw(names)) };
    (0..names.len())
        .filter_map(|index| names.get(index))
        .filter_map(|name| name.downcast_ref::<CFString>().map(ToString::to_string))
        .collect()
}

/// Whether an attribute can be written.
pub fn settable(element: &AXUIElement, name: &str) -> bool {
    let name = CFString::from_str(name);
    let mut settable: u8 = 0;
    // SAFETY: `settable` is a live local `Boolean` out-parameter.
    let error = unsafe { element.is_attribute_settable(&name, NonNull::from(&mut settable)) };
    error == AXError::Success && settable != 0
}

/// Performs an action. `Ok` means the app accepted it, not that it had an effect.
pub fn perform(element: &AXUIElement, action: &str) -> Result<(), i32> {
    let action = CFString::from_str(action);
    // SAFETY: both references are valid for the call.
    let error = unsafe { element.perform_action(&action) };
    if error == AXError::Success {
        Ok(())
    } else {
        Err(error.0)
    }
}

/// Writes a string attribute (`AXValue` of a text field).
pub fn set_string(element: &AXUIElement, name: &str, value: &str) -> Result<(), i32> {
    let name = CFString::from_str(name);
    let value = CFString::from_str(value);
    // SAFETY: both references are valid for the call.
    let error = unsafe { element.set_attribute_value(&name, &value) };
    if error == AXError::Success {
        Ok(())
    } else {
        Err(error.0)
    }
}

/// Writes a boolean attribute (`AXFrontmost`, `AXFocused`, `AXMain`).
pub fn set_bool(element: &AXUIElement, name: &str, value: bool) -> Result<(), i32> {
    let name = CFString::from_str(name);
    // SAFETY: both references are valid for the call; CFBoolean is static.
    let error = unsafe { element.set_attribute_value(&name, CFBoolean::new(value)) };
    if error == AXError::Success {
        Ok(())
    } else {
        Err(error.0)
    }
}

/// The deepest element at a global point, as seen from `root`.
pub fn element_at(root: &AXUIElement, x: f32, y: f32) -> Option<Element> {
    let mut hit: *const AXUIElement = std::ptr::null();
    // SAFETY: `hit` is a live local out-pointer, read only on success.
    let error = unsafe { root.copy_element_at_position(x, y, NonNull::from(&mut hit)) };
    if error != AXError::Success {
        return None;
    }
    let hit = NonNull::new(hit.cast_mut())?;
    // SAFETY: Copy-rule result, owned by us.
    Some(unsafe { CFRetained::from_raw(hit) })
}

/// The pid that owns an element.
pub fn pid(element: &AXUIElement) -> Option<i32> {
    let mut pid: libc::pid_t = 0;
    // SAFETY: `pid` is a live local out-parameter.
    let error = unsafe { element.pid(NonNull::from(&mut pid)) };
    (error == AXError::Success).then_some(pid)
}

/// Whether this process holds the Accessibility grant, optionally prompting.
pub fn is_trusted(prompt: bool) -> bool {
    // The documented key is `kAXTrustedCheckOptionPrompt`, whose value is this
    // string; spelling it avoids linking the extern static.
    let key = CFString::from_str("AXTrustedCheckOptionPrompt");
    let options =
        CFDictionary::<CFString, CFBoolean>::from_slices(&[&key], &[CFBoolean::new(prompt)]);
    // SAFETY: the dictionary is valid for the call and has the documented shape.
    unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) }
}

/// Puts up to 20 UTF-16 units of text on a keyboard event.
pub fn set_unicode(event: &CGEvent, units: &[u16]) {
    // SAFETY: `units` is a live slice and `len` is its exact length.
    unsafe { CGEvent::keyboard_set_unicode_string(Some(event), units.len() as _, units.as_ptr()) };
}

/// One entry of the Window Server's on-screen window list.
pub struct WindowInfo {
    pub id: u32,
    pub pid: i32,
    pub layer: i64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Absent without the Screen Recording grant.
    pub title: Option<String>,
}

/// On-screen windows, front to back.
///
/// Read directly rather than through `xcap`, because bounds, owner, and layer
/// need no permission while `xcap` skips every window whose title it cannot
/// read — which, without Screen Recording, is all of them.
pub fn window_list() -> Vec<WindowInfo> {
    use objc2_core_foundation::CFNumber;
    use objc2_core_graphics::{CGWindowListCopyWindowInfo, CGWindowListOption};

    let options =
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(options, 0) else {
        return Vec::new();
    };
    // SAFETY: the window list is documented as an array of CFDictionary with
    // CFString keys; each value is still downcast before it is read.
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> =
        unsafe { CFRetained::cast_unchecked(list) };
    let number = |dict: &CFDictionary<CFString, CFType>, key: &str| {
        dict.get(&CFString::from_str(key))
            .and_then(|value| value.downcast::<CFNumber>().ok())
            .and_then(|value| value.as_cgfloat())
    };
    let text = |dict: &CFDictionary<CFString, CFType>, key: &str| {
        dict.get(&CFString::from_str(key))
            .and_then(|value| value.downcast_ref::<CFString>().map(ToString::to_string))
    };
    (0..list.len())
        .filter_map(|index| list.get(index))
        .filter_map(|dict| {
            let bounds = dict
                .get(&CFString::from_str("kCGWindowBounds"))
                .and_then(|value| value.downcast::<CFDictionary>().ok())?;
            // SAFETY: `kCGWindowBounds` is a dictionary of CFString keys
            // (`X`, `Y`, `Width`, `Height`) to CFNumbers, downcast below.
            let bounds: CFRetained<CFDictionary<CFString, CFType>> =
                unsafe { CFRetained::cast_unchecked(bounds) };
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Some(WindowInfo {
                id: number(&dict, "kCGWindowNumber")? as u32,
                pid: number(&dict, "kCGWindowOwnerPID")? as i32,
                layer: number(&dict, "kCGWindowLayer").unwrap_or(0.0) as i64,
                x: number(&bounds, "X")?,
                y: number(&bounds, "Y")?,
                w: number(&bounds, "Width")?,
                h: number(&bounds, "Height")?,
                title: text(&dict, "kCGWindowName"),
            })
        })
        .collect()
}

/// Delivers pending run-loop work without waiting.
///
/// The helper has no app event loop, and `NSWorkspace` learns about launched,
/// quit, and activated apps through run-loop notifications; without a pump its
/// app list freezes at first use. One non-blocking pass before each query
/// keeps it current.
pub fn pump_run_loop() {
    use objc2_core_foundation::{kCFRunLoopDefaultMode, CFRunLoop};
    // SAFETY: reading an immutable CoreFoundation constant that is valid for
    // the life of the process.
    let mode = unsafe { kCFRunLoopDefaultMode };
    let _ = CFRunLoop::run_in_mode(mode, 0.0, false);
}

extern "C" {
    /// From `<spawn_private.h>`, exported by libSystem since macOS 10.14: a
    /// child spawned with this attribute is its own TCC "responsible
    /// process" instead of inheriting the app that started the chain.
    fn responsibility_spawnattrs_setdisclaim(
        attrs: *mut libc::posix_spawnattr_t,
        disclaim: libc::c_int,
    ) -> libc::c_int;
}

/// Runs `program` with `args` and `env` as its own responsible process,
/// inheriting the standard streams, and returns its exit code once it ends.
///
/// # Errors
///
/// The `errno` of a failed spawn or wait.
pub fn run_disclaimed(
    program: &std::ffi::CStr,
    args: &[std::ffi::CString],
    env: &[std::ffi::CString],
) -> Result<i32, i32> {
    let mut arg_ptrs: Vec<*mut libc::c_char> = args.iter().map(|a| a.as_ptr().cast_mut()).collect();
    arg_ptrs.push(std::ptr::null_mut());
    let mut env_ptrs: Vec<*mut libc::c_char> = env.iter().map(|e| e.as_ptr().cast_mut()).collect();
    env_ptrs.push(std::ptr::null_mut());
    let mut attrs: libc::posix_spawnattr_t = std::ptr::null_mut();
    // SAFETY: `attrs` is a valid out-pointer; it is destroyed below on every
    // path after a successful init.
    let error = unsafe { libc::posix_spawnattr_init(&raw mut attrs) };
    if error != 0 {
        return Err(error);
    }
    // SAFETY: `attrs` was initialized above.
    let error = unsafe { responsibility_spawnattrs_setdisclaim(&raw mut attrs, 1) };
    let mut pid: libc::pid_t = 0;
    let error = if error == 0 {
        // SAFETY: `program`, `arg_ptrs`, and `env_ptrs` are NUL-terminated and
        // outlive the call; both end in a null pointer as
        // `posix_spawn` requires; `attrs` is initialized.
        unsafe {
            libc::posix_spawn(
                &raw mut pid,
                program.as_ptr(),
                std::ptr::null(),
                &raw const attrs,
                arg_ptrs.as_ptr(),
                env_ptrs.as_ptr(),
            )
        }
    } else {
        error
    };
    // SAFETY: `attrs` was initialized above and is not used again.
    unsafe { libc::posix_spawnattr_destroy(&raw mut attrs) };
    if error != 0 {
        return Err(error);
    }
    let mut status: libc::c_int = 0;
    loop {
        // SAFETY: `pid` is our own child and `status` a valid out-pointer.
        if unsafe { libc::waitpid(pid, &raw mut status, 0) } == pid {
            break;
        }
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if errno != libc::EINTR {
            return Err(errno);
        }
    }
    Ok(if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        128 + libc::WTERMSIG(status)
    })
}

// ------------------------------------------------------------------ SkyLight

// Background input: delivering events to one process without activating it,
// raising its window, or moving the user's pointer. Every symbol is private
// (`SkyLight.framework`), resolved once with `dlsym`, and optional: a missing
// one turns background delivery off and the caller falls back to activating
// the target. The recipe (focus-without-raise records, the window-routing
// fields on pointer events, the authentication message on keys) is the one
// yabai established and trycua's cua-driver measured across AppKit, WebKit,
// and Chromium apps.

use std::ffi::{c_void, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use objc2::runtime::{Bool, Sel};

type PostToPid = unsafe extern "C" fn(libc::pid_t, *mut c_void);
type SetIntegerField = unsafe extern "C" fn(*mut c_void, u32, i64);
type SetWindowLocation = unsafe extern "C" fn(*mut c_void, f64, f64);
type SetAuthMessage = unsafe extern "C" fn(*mut c_void, *mut c_void);
type MainConnection = unsafe extern "C" fn() -> u32;
type WindowOwner = unsafe extern "C" fn(u32, u32, *mut u32) -> i32;
type ConnectionPsn = unsafe extern "C" fn(u32, *mut c_void) -> i32;
type ProcessForPid = unsafe extern "C" fn(libc::pid_t, *mut c_void) -> i32;
type PostEventRecord = unsafe extern "C" fn(*const c_void, *const u8) -> i32;
type AuthFactory =
    unsafe extern "C" fn(*mut c_void, Sel, *mut c_void, libc::c_int, u32) -> *mut c_void;
type RespondsTo = unsafe extern "C" fn(*mut c_void, Sel, Sel) -> Bool;

/// The resolved private calls; `None` fields were not found on this macOS.
struct SkyLight {
    post_to_pid: Option<PostToPid>,
    set_integer_field: Option<SetIntegerField>,
    set_window_location: Option<SetWindowLocation>,
    set_auth_message: Option<SetAuthMessage>,
    main_connection: Option<MainConnection>,
    window_owner: Option<WindowOwner>,
    connection_psn: Option<ConnectionPsn>,
    process_for_pid: Option<ProcessForPid>,
    post_event_record: Option<PostEventRecord>,
    msg_send: Option<*mut c_void>,
}

// SAFETY: the fields are immutable function addresses in loaded system images.
unsafe impl Send for SkyLight {}
// SAFETY: as above; nothing is ever written after resolution.
unsafe impl Sync for SkyLight {}

/// `SLPSPostEventRecordTo`'s "invalid connection": this process has no usable
/// Window Server connection for the target, so focus records are dropped.
const INVALID_CONNECTION: i32 = 1002;
static CONNECTION_INVALID: AtomicBool = AtomicBool::new(false);

fn symbol(name: &CStr) -> Option<*mut c_void> {
    // SAFETY: `name` is NUL-terminated; `RTLD_DEFAULT` searches every loaded
    // image, and a missing symbol is a null return, not an error.
    let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!pointer.is_null()).then_some(pointer)
}

fn skylight() -> &'static SkyLight {
    static SKYLIGHT: OnceLock<SkyLight> = OnceLock::new();
    SKYLIGHT.get_or_init(|| {
        // SAFETY: a constant, NUL-terminated system path; a failed load leaves
        // every symbol below unresolved.
        unsafe {
            libc::dlopen(
                c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(),
                libc::RTLD_LAZY | libc::RTLD_GLOBAL,
            );
        }
        // SAFETY (each `transmute`): the address is the named C function, whose
        // signature is the one spelled by the target type (reverse-engineered,
        // matching yabai and cua-driver).
        macro_rules! resolve {
            ($name:literal) => {
                symbol($name).map(|pointer| unsafe { std::mem::transmute(pointer) })
            };
        }
        SkyLight {
            post_to_pid: resolve!(c"SLEventPostToPid"),
            set_integer_field: resolve!(c"SLEventSetIntegerValueField"),
            set_window_location: resolve!(c"CGEventSetWindowLocation"),
            set_auth_message: resolve!(c"SLEventSetAuthenticationMessage"),
            main_connection: resolve!(c"CGSMainConnectionID"),
            window_owner: resolve!(c"SLSGetWindowOwner"),
            connection_psn: resolve!(c"SLSGetConnectionPSN"),
            process_for_pid: resolve!(c"GetProcessForPID"),
            post_event_record: resolve!(c"SLPSPostEventRecordTo"),
            msg_send: symbol(c"objc_msgSend"),
        }
    })
}

/// Whether events can be delivered to a background process at all.
pub fn background_input_available() -> bool {
    let sky = skylight();
    sky.post_to_pid.is_some() && sky.post_event_record.is_some() && !connection_invalid()
}

/// True once a focus record came back "invalid connection"; background
/// pointer input is then off for the life of the helper.
pub fn connection_invalid() -> bool {
    CONNECTION_INVALID.load(Ordering::Relaxed)
}

fn raw(event: &CGEvent) -> *mut c_void {
    std::ptr::from_ref(event).cast_mut().cast()
}

/// Sets a raw event field, including the private window-routing ones.
pub fn set_event_field(event: &CGEvent, field: u32, value: i64) {
    match skylight().set_integer_field {
        // SAFETY: `event` is a live CGEvent for the duration of the call.
        Some(set) => unsafe { set(raw(event), field, value) },
        None => CGEvent::set_integer_value_field(
            Some(event),
            objc2_core_graphics::CGEventField(field),
            value,
        ),
    }
}

/// Stamps the screen point the Window Server routes a pid-posted pointer
/// event by.
pub fn set_window_location(event: &CGEvent, point: CGPoint) {
    if let Some(set) = skylight().set_window_location {
        // SAFETY: `event` is live; `CGPoint` is two doubles, passed as two
        // floating-point arguments by the arm64 and x86-64 C ABIs alike.
        unsafe { set(raw(event), point.x, point.y) };
    }
}

/// Posts `event` to `pid` only. `authenticate` attaches the authentication
/// message Chromium-based apps require of synthetic keys (pointer events do
/// not take one).
pub fn post_to_pid(pid: i32, event: &CGEvent, authenticate: bool) {
    let sky = skylight();
    let Some(post) = sky.post_to_pid else {
        CGEvent::post_to_pid(pid, Some(event));
        return;
    };
    if authenticate {
        attach_auth_message(sky, pid, event);
    }
    // SAFETY: `event` is live for the call; any pid is accepted.
    unsafe { post(pid, raw(event)) };
}

/// `+[SLSEventAuthenticationMessage messageWithEventRecord:pid:version:]`
/// (macOS 15+), attached to the event. Skipped wherever any part is missing.
fn attach_auth_message(sky: &SkyLight, pid: i32, event: &CGEvent) {
    let (Some(msg_send), Some(set_message)) = (sky.msg_send, sky.set_auth_message) else {
        return;
    };
    let Some(class) = objc2::runtime::AnyClass::get(c"SLSEventAuthenticationMessage") else {
        return;
    };
    let class = std::ptr::from_ref(class).cast_mut().cast::<c_void>();
    let factory = objc2::sel!(messageWithEventRecord:pid:version:);
    // SAFETY: `objc_msgSend` called with the class object, `respondsToSelector:`,
    // and a selector, which is that method's signature.
    let has_factory = unsafe {
        std::mem::transmute::<*mut c_void, RespondsTo>(msg_send)(
            class,
            objc2::sel!(respondsToSelector:),
            factory,
        )
    };
    if !has_factory.as_bool() {
        return;
    }
    // A CGEvent is `{CFRuntimeBase (16 bytes), uint32_t, SLSEventRecord *}`,
    // so the record pointer sits at offset 24, inside the object.
    // SAFETY: `event` is a live CGEvent, at least 32 bytes long; the read is
    // unaligned-safe and only the pointer value is used.
    let record =
        unsafe { std::ptr::read_unaligned(raw(event).cast::<u8>().add(24).cast::<*mut c_void>()) };
    if record.is_null() {
        return;
    }
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: `objc_msgSend` with the factory's signature
        // `(Class, SEL, SLSEventRecord *, pid_t, uint32_t) -> id`; the result
        // is autoreleased into this pool and retained by the event when set.
        let message = unsafe {
            std::mem::transmute::<*mut c_void, AuthFactory>(msg_send)(
                class, factory, record, pid, 0,
            )
        };
        if !message.is_null() {
            // SAFETY: `event` is live and `message` a live object.
            unsafe { set_message(raw(event), message) };
        }
    });
}

/// The 8-byte process serial number of the process owning `window`.
fn psn_for_window(sky: &SkyLight, window: u32, pid: i32) -> Option<[u8; 8]> {
    let mut psn = [0u8; 8];
    if let (Some(main), Some(owner), Some(connection_psn)) =
        (sky.main_connection, sky.window_owner, sky.connection_psn)
    {
        let mut owner_connection = 0u32;
        // SAFETY: `owner_connection` and `psn` are live out-pointers of the
        // sizes the calls write (a connection id, an 8-byte PSN).
        let found = unsafe {
            owner(main(), window, &raw mut owner_connection) == 0
                && owner_connection != 0
                && connection_psn(owner_connection, psn.as_mut_ptr().cast()) == 0
        };
        if found {
            return Some(psn);
        }
    }
    let for_pid = sky.process_for_pid?;
    // SAFETY: `psn` is a live 8-byte out-pointer.
    (unsafe { for_pid(pid, psn.as_mut_ptr().cast()) } == 0).then_some(psn)
}

/// Makes `window` the target app's AppKit-active window for event routing
/// without raising it, activating the app, or taking key status from the
/// user's window: one focus record, to the target only.
///
/// Returns `false` when the record could not be posted; the caller then falls
/// back to activating the app.
pub fn focus_without_raise(pid: i32, window: u32) -> bool {
    let sky = skylight();
    let Some(post) = sky.post_event_record else {
        return false;
    };
    let Some(psn) = psn_for_window(sky, window, pid) else {
        return false;
    };
    let mut record = [0u8; 0xF8];
    record[0x04] = 0xF8;
    record[0x08] = 0x0D;
    record[0x3C..0x40].copy_from_slice(&window.to_le_bytes());
    record[0x8A] = 0x01;
    // SAFETY: `psn` and `record` are live buffers of the sizes the call reads
    // (8 and 0xF8 bytes).
    let status = unsafe { post(psn.as_ptr().cast(), record.as_ptr()) };
    if status == INVALID_CONNECTION {
        CONNECTION_INVALID.store(true, Ordering::Relaxed);
    }
    status == 0
}

/// Whether the modern screenshot API is available on this host.
pub fn supports_screen_capture_kit() -> bool {
    objc2_foundation::NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(
        objc2_foundation::NSOperatingSystemVersion {
            majorVersion: 14,
            minorVersion: 0,
            patchVersion: 0,
        },
    )
}

/// A `ScreenCaptureKit` screenshot. No borrowed `CGImage` crosses the channel.
pub fn capture_image(
    target: &crate::capture::CaptureTarget,
    max_width: Option<u32>,
    hide_pids: &[u64],
) -> crate::ComputerResult<(image::RgbaImage, pragma_constants::ComputerRect)> {
    use block2::RcBlock;
    use objc2_foundation::NSError;
    use objc2_screen_capture_kit::SCShareableContent;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let target = target.clone();
    let hide_pids = hide_pids.to_vec();
    let completion = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            if !error.is_null() || content.is_null() {
                let _ = tx.send(Err(capture_permission_error()));
                return;
            }
            // SAFETY: ScreenCaptureKit lends content for the duration of this callback.
            let result = capture_content(
                unsafe { &*content },
                &target,
                &hide_pids,
                max_width,
                tx.clone(),
            );
            if let Err(error) = result {
                let _ = tx.send(Err(error));
            }
        },
    );
    // SAFETY: ScreenCaptureKit copies the block. Captured channel/data are Send,
    // and all Objective-C objects are created/retained on the callback thread.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true,false,&completion);
    }
    rx.recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| {
            crate::failure(
                pragma_constants::ComputerErrorCode::Timeout,
                "ScreenCaptureKit screenshot timed out",
            )
        })?
}

fn capture_permission_error() -> pragma_constants::ComputerFailure {
    crate::failure(
        pragma_constants::ComputerErrorCode::PermissionMissing,
        "ScreenCaptureKit could not capture the screen; check Screen Recording permission",
    )
}

type CapturedImage = (image::RgbaImage, pragma_constants::ComputerRect);
fn capture_content(
    content: &objc2_screen_capture_kit::SCShareableContent,
    target: &crate::capture::CaptureTarget,
    hide_pids: &[u64],
    max_width: Option<u32>,
    tx: std::sync::mpsc::SyncSender<crate::ComputerResult<CapturedImage>>,
) -> crate::ComputerResult<()> {
    use block2::RcBlock;
    use objc2_foundation::NSError;
    use objc2_screen_capture_kit::SCScreenshotManager;
    let (filter, frame, source) = capture_filter(content, target, hide_pids)?;
    let config = capture_configuration(&filter, &frame, source, max_width);
    let completion = RcBlock::new(
        move |image: *mut objc2_core_graphics::CGImage, error: *mut NSError| {
            if !error.is_null() || image.is_null() {
                let _ = tx.send(Err(capture_permission_error()));
                return;
            }
            // SAFETY: the screenshot manager lends a valid CGImage for this callback.
            let pixels = copy_screenshot_pixels(unsafe { &*image });
            let _ = tx.send(pixels.map(|pixels| (pixels, frame.clone())));
        },
    );
    // SAFETY: filter/configuration are retained; the manager copies the completion
    // block and retains its arguments until the screenshot has finished.
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &config,
            Some(&completion),
        );
    }
    Ok(())
}

type CaptureFilter = (
    objc2::rc::Retained<objc2_screen_capture_kit::SCContentFilter>,
    pragma_constants::ComputerRect,
    Option<objc2_core_foundation::CGRect>,
);
fn capture_filter(
    content: &objc2_screen_capture_kit::SCShareableContent,
    target: &crate::capture::CaptureTarget,
    hide_pids: &[u64],
) -> crate::ComputerResult<CaptureFilter> {
    use crate::capture::CaptureTarget;
    use objc2::AllocAnyThread;
    use objc2_foundation::NSArray;
    use objc2_screen_capture_kit::SCContentFilter;
    use pragma_constants::{ComputerErrorCode, ComputerRect};
    // SAFETY: content lives through this call; filters retain their native targets.
    unsafe {
        let windows = content.windows();
        if let CaptureTarget::Window { raw_id, frame } = target {
            let window = windows
                .iter()
                .find(|w| w.windowID() == *raw_id)
                .ok_or_else(|| {
                    crate::failure(
                        ComputerErrorCode::WindowNotFound,
                        "The capture window closed",
                    )
                })?;
            return Ok((
                SCContentFilter::initWithDesktopIndependentWindow(
                    SCContentFilter::alloc(),
                    &window,
                ),
                frame.clone(),
                None,
            ));
        }
        let displays = content.displays();
        let display = displays
            .iter()
            .find(|d| match target {
                CaptureTarget::Region(region) => {
                    let r = d.frame();
                    region.x >= r.origin.x
                        && region.y >= r.origin.y
                        && region.x < r.origin.x + r.size.width
                        && region.y < r.origin.y + r.size.height
                }
                CaptureTarget::Display { raw_id } => raw_id.is_none_or(|id| d.displayID() == id),
                CaptureTarget::Window { .. } => false,
            })
            .ok_or_else(|| {
                crate::failure(
                    ComputerErrorCode::WindowNotFound,
                    "No matching capture display",
                )
            })?;
        let r = display.frame();
        // Recent macOS versions ignore NSWindow sharingType for SCK: exclude
        // Pragma windows explicitly so the preview never captures its own
        // overlay, and every window of an app agents may not read.
        let excluded: Vec<_> = windows
            .iter()
            .filter(|w| {
                w.owningApplication().is_some_and(|a| {
                    a.bundleIdentifier().to_string().starts_with("com.pragma")
                        || u64::try_from(a.processID()).is_ok_and(|pid| hide_pids.contains(&pid))
                })
            })
            .collect();
        let excluded = NSArray::from_retained_slice(&excluded);
        let filter = SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &excluded,
        );
        let (frame, source) = if let CaptureTarget::Region(region) = target {
            if !region.w.is_finite()
                || !region.h.is_finite()
                || region.w <= 0.0
                || region.h <= 0.0
                || region.x + region.w > r.origin.x + r.size.width
                || region.y + region.h > r.origin.y + r.size.height
            {
                return Err(crate::failure(
                    ComputerErrorCode::InvalidPayload,
                    "Capture region must fit within one display",
                ));
            }
            (
                region.clone(),
                Some(objc2_core_foundation::CGRect::new(
                    CGPoint::new(region.x - r.origin.x, region.y - r.origin.y),
                    CGSize::new(region.w, region.h),
                )),
            )
        } else {
            (
                ComputerRect {
                    x: r.origin.x,
                    y: r.origin.y,
                    w: r.size.width,
                    h: r.size.height,
                    display_id: Some(format!("display:mac:{}", display.displayID())),
                },
                None,
            )
        };
        Ok((filter, frame, source))
    }
}

fn capture_configuration(
    filter: &objc2_screen_capture_kit::SCContentFilter,
    frame: &pragma_constants::ComputerRect,
    source: Option<objc2_core_foundation::CGRect>,
    max_width: Option<u32>,
) -> objc2::rc::Retained<objc2_screen_capture_kit::SCStreamConfiguration> {
    // SAFETY: retained native objects. The dimensions are validated positive,
    // finite screen dimensions, narrowed to the caller's requested output width.
    unsafe {
        let config = objc2_screen_capture_kit::SCStreamConfiguration::new();
        let scale = f64::from(filter.pointPixelScale()).max(1.0);
        let width = max_width.map_or(frame.w * scale, |max| (frame.w * scale).min(f64::from(max)));
        config.setWidth(capture_dimension(width));
        config.setHeight(capture_dimension(width * frame.h / frame.w));
        config.setShowsCursor(false);
        config.setPixelFormat(u32::from_be_bytes(*b"BGRA"));
        if let Some(source) = source {
            config.setSourceRect(source);
        }
        config
    }
}
// ScreenCaptureKit sizes are integer pixels; saturating conversion is intentional.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn capture_dimension(value: f64) -> usize {
    value.round().max(1.0) as usize
}

fn copy_screenshot_pixels(
    image: &objc2_core_graphics::CGImage,
) -> crate::ComputerResult<image::RgbaImage> {
    use objc2_core_graphics::{CGDataProvider, CGImage};
    use pragma_constants::ComputerErrorCode;
    let invalid = || {
        crate::failure(
            ComputerErrorCode::Internal,
            "ScreenCaptureKit returned an invalid image",
        )
    };
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let stride = CGImage::bytes_per_row(Some(image));
    if CGImage::bits_per_pixel(Some(image)) != 32
        || width == 0
        || height == 0
        || stride < width.saturating_mul(4)
    {
        return Err(invalid());
    }
    let provider = CGImage::data_provider(Some(image)).ok_or_else(invalid)?;
    let data = CGDataProvider::data(Some(&provider))
        .ok_or_else(invalid)?
        .to_vec();
    if data.len() < stride.saturating_mul(height) {
        return Err(invalid());
    }
    let mut rgba = Vec::with_capacity(width.saturating_mul(height).saturating_mul(4));
    for row in data.chunks_exact(stride).take(height) {
        for pixel in row[..width * 4].as_chunks::<4>().0 {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }
    image::RgbaImage::from_raw(
        u32::try_from(width).map_err(|_| invalid())?,
        u32::try_from(height).map_err(|_| invalid())?,
        rgba,
    )
    .ok_or_else(invalid)
}
