//! Safe wrappers over UI Automation, `SendInput`, and Win32 application management.
//! All Windows unsafe code stays here. COM objects stay on the helper's MTA thread.
#![allow(unsafe_code)]
use crate::snapshot::RawNode;
use crate::{failure, ComputerResult};
use pragma_constants::{ComputerErrorCode, ComputerMouseButton, ComputerPoint, ComputerRect};
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Once, OnceLock};
use std::time::Instant;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement,
    IUIAutomationInvokePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
    TreeScope_Element, UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId,
    UIA_ControlTypePropertyId, UIA_HasKeyboardFocusPropertyId, UIA_InvokePatternId,
    UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId,
    UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId, UIA_ValuePatternId,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, SetFocus, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CallNextHookEx, GetCursorPos, GetForegroundWindow, GetMessageW,
    GetWindowThreadProcessId, IsIconic, SetForegroundWindow, SetWindowsHookExW, ShowWindow,
    SwitchToThisWindow, WindowFromPoint, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG,
    MSLLHOOKSTRUCT, SW_RESTORE, SW_SHOWNORMAL, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE,
    WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

pub type Element = IUIAutomationElement;
fn hwnd(raw: u32) -> HWND {
    HWND(raw as usize as *mut std::ffi::c_void)
}
fn error(_: windows::core::Error) -> pragma_constants::ComputerFailure {
    failure(
        ComputerErrorCode::ElementStale,
        "The accessibility element is no longer available",
    )
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

/// UIA interfaces are released before the apartment is uninitialized.
pub struct Automation {
    api: Option<IUIAutomation>,
    cache: Option<IUIAutomationCacheRequest>,
    walker: Option<IUIAutomationTreeWalker>,
}
impl Automation {
    pub fn new() -> ComputerResult<Self> {
        // SAFETY: the helper's worker thread has no COM apartment; successful init is balanced in Drop.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(error)?;
        }
        // SAFETY: process-local setting, before any window/capture calls. A manifest can already have set it.
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        // SAFETY: CUIAutomation is an in-process COM class created on the initialized MTA.
        let api: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(error)?;
        // SAFETY: retained interfaces; every added property has its correctly typed UIA id.
        let (cache, walker) = unsafe {
            let cache = api.CreateCacheRequest().map_err(error)?;
            cache.SetTreeScope(TreeScope_Element).map_err(error)?;
            for id in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_LocalizedControlTypePropertyId,
                UIA_AutomationIdPropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsPasswordPropertyId,
                UIA_IsOffscreenPropertyId,
            ] {
                cache.AddProperty(id).map_err(error)?;
            }
            (cache, api.ControlViewWalker().map_err(error)?)
        };
        Ok(Self {
            api: Some(api),
            cache: Some(cache),
            walker: Some(walker),
        })
    }
    pub fn root(&self, window: u32) -> ComputerResult<Element> {
        let api = self
            .api
            .as_ref()
            .ok_or_else(|| failure(ComputerErrorCode::Internal, "UIA unavailable"))?;
        // SAFETY: HWNDs are borrowed; UIA validates a window that has closed and returns an error.
        unsafe { api.ElementFromHandle(hwnd(window)) }.map_err(error)
    }
    pub fn children(&self, element: &Element, max: usize) -> Vec<Element> {
        let (Some(walker), Some(cache)) = (&self.walker, &self.cache) else {
            return vec![];
        };
        let mut children = vec![];
        // SAFETY: all elements and cache interfaces are retained on this MTA thread.
        unsafe {
            let mut next = walker.GetFirstChildElementBuildCache(element, cache);
            while let Ok(child) = next {
                if children.len() >= max {
                    break;
                }
                next = walker.GetNextSiblingElementBuildCache(&child, cache);
                children.push(child);
            }
        }
        children
    }
    pub fn node(
        &self,
        element: &Element,
        path: Vec<u64>,
        ancestor_roles: Vec<String>,
    ) -> ComputerResult<RawNode> {
        let cache = self
            .cache
            .as_ref()
            .ok_or_else(|| failure(ComputerErrorCode::Internal, "UIA unavailable"))?;
        // SAFETY: cache and element are retained UIA interfaces on the same initialized thread.
        unsafe {
            let e = element.BuildUpdatedCache(cache).map_err(error)?;
            // A failed password-property read is treated as secure. Never probe a value first.
            let secure = e
                .CachedIsPassword()
                .map_or(true, windows::core::BOOL::as_bool);
            let pattern: Option<IUIAutomationValuePattern> = if secure {
                None
            } else {
                element.GetCurrentPatternAs(UIA_ValuePatternId).ok()
            };
            let role = control_role(e.CachedControlType().map(|id| id.0).unwrap_or_default());
            let editable = role == "Edit"
                || pattern
                    .as_ref()
                    .is_some_and(|v| v.CurrentIsReadOnly().is_ok_and(|v| !v.as_bool()));
            let value = pattern
                .as_ref()
                .and_then(|v| v.CurrentValue().ok())
                .map(|v| v.to_string());
            let r = e.CachedBoundingRectangle().ok();
            let actions = if element
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .is_ok()
            {
                vec!["press".to_string()]
            } else {
                vec![]
            };
            Ok(RawNode {
                role: role.to_string(),
                title: e.CachedName().ok().map(|s| s.to_string()),
                identifier: e.CachedAutomationId().ok().map(|s| s.to_string()),
                frame: r.map(|r| ComputerRect {
                    x: f64::from(r.left),
                    y: f64::from(r.top),
                    w: f64::from(r.right - r.left),
                    h: f64::from(r.bottom - r.top),
                    display_id: None,
                }),
                offscreen: e
                    .CachedIsOffscreen()
                    .map_or(true, windows::core::BOOL::as_bool),
                enabled: e.CachedIsEnabled().is_ok_and(windows::core::BOOL::as_bool),
                focused: e
                    .CachedHasKeyboardFocus()
                    .is_ok_and(windows::core::BOOL::as_bool),
                secure,
                editable,
                value,
                actions,
                path,
                ancestor_roles,
                ..RawNode::default()
            })
        }
    }
}
impl Drop for Automation {
    fn drop(&mut self) {
        self.walker.take();
        self.cache.take();
        self.api.take();
        // SAFETY: balances this thread's successful CoInitializeEx after releasing its interfaces.
        unsafe {
            CoUninitialize();
        }
    }
}
/// Invoke supports background controls without changing the physical cursor.
pub fn invoke(element: &Element) -> ComputerResult<()> {
    // SAFETY: retained interface; UIA validates the pattern and the element's current liveness.
    unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .and_then(|p| p.Invoke())
    }
    .map_err(error)
}
pub fn set_value(element: &Element, text: &str) -> ComputerResult<()> {
    let text = windows::core::BSTR::from(text);
    // SAFETY: a retained UIA interface and a null-terminated UTF-16 buffer live through the call.
    unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|p| p.SetValue(&text))
    }
    .map_err(error)
}
pub fn focus_element(element: &Element) -> ComputerResult<()> {
    // SAFETY: retained interface, on its apartment thread.
    unsafe { element.SetFocus() }.map_err(error)
}
pub fn foreground_pid() -> Option<u64> {
    let mut pid = 0;
    // SAFETY: the output points to a live u32; HWND is obtained from Windows.
    unsafe {
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&raw mut pid));
    }
    (pid != 0).then_some(u64::from(pid))
}
pub fn activate(window: u32) -> ComputerResult<()> {
    // SAFETY: Win32 validates borrowed HWNDs. No pointers are dereferenced by Rust.
    unsafe {
        let target = hwnd(window);
        // `SW_RESTORE` also un-maximizes, so only use it for a minimized window.
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        if GetForegroundWindow() == target {
            return Ok(());
        }
        // A TRUE return does not guarantee the switch happened, so verify.
        if SetForegroundWindow(target).as_bool() && GetForegroundWindow() == target {
            return Ok(());
        }
        // A background process may not take the foreground while another app
        // owns it. Windows allows it when the caller shares the foreground
        // thread's input queue, so join that queue for the duration of the call.
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let current_thread = GetCurrentThreadId();
        let attached = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();
        let raised = SetForegroundWindow(target).as_bool();
        let _ = BringWindowToTop(target);
        let _ = SetFocus(Some(target));
        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
        if raised && GetForegroundWindow() == target {
            return Ok(());
        }
        // Last resort: the shell's own activation path, still honoured by
        // Windows 11 for launchers and tool windows.
        SwitchToThisWindow(target, true);
        if GetForegroundWindow() == target {
            return Ok(());
        }
    }
    Err(failure(
        ComputerErrorCode::TargetChanged,
        "Windows refused foreground activation",
    ))
}
pub fn process_path(pid: u32) -> Option<String> {
    // SAFETY: limited-query process handle is closed on every path; buffer length matches its capacity.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0_u16; 32768];
        let mut len = 32768;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &raw mut len,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..len as usize]))
    }
}
/// Reads `TokenElevation` for an already-open process handle.
fn token_elevated(process: HANDLE) -> Option<bool> {
    // SAFETY: the borrowed process handle stays open for the call; the token it yields is closed here.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &raw mut token).ok()?;
        let mut elevation = TOKEN_ELEVATION::default();
        let mut needed = 0;
        let result = GetTokenInformation(
            token,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            u32::try_from(size_of::<TOKEN_ELEVATION>()).unwrap_or(u32::MAX),
            &raw mut needed,
        );
        let _ = CloseHandle(token);
        result.ok()?;
        Some(elevation.TokenIsElevated != 0)
    }
}

fn self_elevated() -> bool {
    // SAFETY: GetCurrentProcess returns a pseudo-handle that is never closed and is valid in this process.
    token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false)
}

/// Refuses only a window this helper's token cannot reach.
///
/// Windows blocks synthetic input and UI Automation across an integrity boundary,
/// not at "elevated" itself: an elevated helper controls elevated apps exactly as it
/// controls standard ones. Refusing every elevated target outright meant that a
/// Pragma started as administrator could open an app and then never drive it.
pub fn refuse_elevated(pid: u32) -> ComputerResult<()> {
    // SAFETY: this limited-query process handle is closed on every path.
    let target_elevated = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|_| {
            failure(
                ComputerErrorCode::TargetElevated,
                "Target process cannot be queried",
            )
        })?;
        let elevated = token_elevated(process);
        let _ = CloseHandle(process);
        elevated
    };
    let target_elevated = target_elevated.ok_or_else(|| {
        failure(
            ComputerErrorCode::TargetElevated,
            "Target elevation cannot be checked",
        )
    })?;
    if !target_elevated || self_elevated() {
        return Ok(());
    }
    Err(failure(
        ComputerErrorCode::TargetElevated,
        "This window runs elevated; restart Pragma as administrator to control it",
    ))
}
pub fn launch(app: &str, argument: Option<&str>) -> ComputerResult<()> {
    let file = wide(app);
    let args = argument.map(wide);
    // SAFETY: all string buffers are null-terminated and live until ShellExecuteW returns.
    let status = unsafe {
        ShellExecuteW(
            None,
            PCWSTR::null(),
            PCWSTR(file.as_ptr()),
            args.as_ref().map_or(PCWSTR::null(), |a| PCWSTR(a.as_ptr())),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if status.0 as usize <= 32 {
        return Err(failure(
            ComputerErrorCode::AppNotFound,
            "Windows could not open that application",
        ));
    }
    Ok(())
}
fn send(input: INPUT) -> ComputerResult<()> {
    // SAFETY: the slice contains one fully initialized INPUT with the matching union tag and ABI size.
    let sent = unsafe {
        SendInput(
            &[input],
            i32::try_from(size_of::<INPUT>()).unwrap_or(i32::MAX),
        )
    };
    if sent != 1 {
        return Err(failure(
            ComputerErrorCode::TargetElevated,
            "Windows refused synthetic input (UIPI or secure desktop)",
        ));
    }
    Ok(())
}
pub fn key(vk: u16, unit: u16, unicode: bool, up: bool) -> ComputerResult<()> {
    let flags = if unicode {
        KEYEVENTF_UNICODE
    } else {
        KEYBD_EVENT_FLAGS(0)
    } | if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    send(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: unit,
                dwFlags: flags,
                ..KEYBDINPUT::default()
            },
        },
    })
}
pub fn move_to(point: &ComputerPoint) -> ComputerResult<()> {
    // SAFETY: scalar screen coordinates, no pointers; PMv2 means physical virtual-screen pixels.
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::SetCursorPos(
            screen_coordinate(point.x),
            screen_coordinate(point.y),
        )
    }
    .map_err(error)
}
pub fn button(button: ComputerMouseButton, up: bool) -> ComputerResult<()> {
    let flag = match (button, up) {
        (ComputerMouseButton::Left, false) => MOUSEEVENTF_LEFTDOWN,
        (ComputerMouseButton::Left, true) => MOUSEEVENTF_LEFTUP,
        (ComputerMouseButton::Right, false) => MOUSEEVENTF_RIGHTDOWN,
        (ComputerMouseButton::Right, true) => MOUSEEVENTF_RIGHTUP,
        (ComputerMouseButton::Middle, false) => MOUSEEVENTF_MIDDLEDOWN,
        (ComputerMouseButton::Middle, true) => MOUSEEVENTF_MIDDLEUP,
    };
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flag,
                ..MOUSEINPUT::default()
            },
        },
    })
}
pub fn scroll(delta: i32, horizontal: bool) -> ComputerResult<()> {
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: if horizontal {
                    MOUSEEVENTF_HWHEEL
                } else {
                    MOUSEEVENTF_WHEEL
                },
                mouseData: delta.cast_unsigned(),
                ..MOUSEINPUT::default()
            },
        },
    })
}
pub fn pointer() -> Option<ComputerPoint> {
    let mut point = POINT::default();
    // SAFETY: writable stack POINT, read only after success.
    unsafe { GetCursorPos(&raw mut point) }.ok()?;
    Some(ComputerPoint {
        x: f64::from(point.x),
        y: f64::from(point.y),
    })
}
pub fn point_pid(point: &ComputerPoint) -> Option<u64> {
    let mut pid = 0;
    // SAFETY: point is by value; output points to a live u32 and Windows validates the HWND.
    unsafe {
        GetWindowThreadProcessId(
            WindowFromPoint(POINT {
                x: screen_coordinate(point.x),
                y: screen_coordinate(point.y),
            }),
            Some(&raw mut pid),
        );
    }
    (pid != 0).then_some(u64::from(pid))
}
// ------------------------------------------------------------------ physical input
//
// `GetAsyncKeyState` cannot tell our own `SendInput` events from the user's, so
// a held Ctrl in a chord, or a button that had not yet been released, read as
// the user taking over. Low-level hooks see the `INJECTED` flag instead.

static INPUT_HOOKS: Once = Once::new();
static HOOKS_READY: AtomicBool = AtomicBool::new(false);
static INPUT_EPOCH: OnceLock<Instant> = OnceLock::new();
/// Milliseconds after `INPUT_EPOCH`, plus one; zero means never seen.
static LAST_KEY: AtomicU64 = AtomicU64::new(0);
static LAST_POINTER: AtomicU64 = AtomicU64::new(0);
/// Physically held mouse buttons, so a drag counts while the pointer moves.
static HELD_BUTTONS: AtomicU8 = AtomicU8::new(0);

fn mark(slot: &AtomicU64) {
    let elapsed = INPUT_EPOCH.get_or_init(Instant::now).elapsed().as_millis();
    slot.store(
        u64::try_from(elapsed).unwrap_or(u64::MAX - 1) + 1,
        Ordering::Relaxed,
    );
}

fn seconds_since(slot: &AtomicU64) -> Option<f64> {
    let at = slot.load(Ordering::Relaxed).checked_sub(1)?;
    let now = u64::try_from(INPUT_EPOCH.get()?.elapsed().as_millis()).ok()?;
    // Millisecond counts stay far below f64's exact-integer range.
    #[allow(clippy::cast_precision_loss)]
    Some(now.saturating_sub(at) as f64 / 1000.0)
}

/// Starts the hook thread once; physical input before this is not seen.
pub fn watch_physical_input() {
    INPUT_HOOKS.call_once(|| {
        INPUT_EPOCH.get_or_init(Instant::now);
        let spawned = std::thread::Builder::new()
            .name("pragma-input-hooks".into())
            .spawn(run_input_hooks);
        drop(spawned);
    });
}

fn run_input_hooks() {
    // SAFETY: the hook procedures are `extern "system"` with the HOOKPROC
    // signature; the module handle names this executable. Low-level hooks are
    // called on this thread, which must therefore pump messages for its life.
    let installed = unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).ok().map(Into::into);
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0).is_ok()
            && SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0).is_ok()
    };
    if !installed {
        return;
    }
    HOOKS_READY.store(true, Ordering::SeqCst);
    let mut msg = MSG::default();
    // SAFETY: writable stack MSG; this thread owns no windows, so this only
    // dispatches the hook callbacks until the process exits.
    while unsafe { GetMessageW(&raw mut msg, None, 0, 0) }.0 > 0 {}
    HOOKS_READY.store(false, Ordering::SeqCst);
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: for HC_ACTION, lparam points to a KBDLLHOOKSTRUCT valid for this call.
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let down = matches!(u32::try_from(wparam.0), Ok(WM_KEYDOWN | WM_SYSKEYDOWN));
        if down && info.flags.0 & LLKHF_INJECTED.0 == 0 {
            mark(&LAST_KEY);
        }
    }
    // SAFETY: forwards the unmodified arguments Windows gave us.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: for HC_ACTION, lparam points to an MSLLHOOKSTRUCT valid for this call.
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if info.flags & LLMHF_INJECTED == 0 {
            physical_mouse(u32::try_from(wparam.0).unwrap_or_default());
        }
    }
    // SAFETY: forwards the unmodified arguments Windows gave us.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn physical_mouse(message: u32) {
    let (bit, down) = match message {
        WM_LBUTTONDOWN => (1, true),
        WM_LBUTTONUP => (1, false),
        WM_RBUTTONDOWN => (2, true),
        WM_RBUTTONUP => (2, false),
        WM_MBUTTONDOWN => (4, true),
        WM_MBUTTONUP => (4, false),
        WM_XBUTTONDOWN => (8, true),
        WM_XBUTTONUP => (8, false),
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => (0, false),
        // Pointer movement alone never counts; a drag with a held button does.
        WM_MOUSEMOVE if HELD_BUTTONS.load(Ordering::Relaxed) != 0 => (0, false),
        _ => return,
    };
    if down {
        HELD_BUTTONS.fetch_or(bit, Ordering::Relaxed);
    } else {
        HELD_BUTTONS.fetch_and(!bit, Ordering::Relaxed);
    }
    mark(&LAST_POINTER);
}

/// Seconds since the last physical (never injected) key press; `None` when unknown.
pub fn physical_keyboard_seconds() -> Option<f64> {
    watch_physical_input();
    HOOKS_READY
        .load(Ordering::SeqCst)
        .then(|| seconds_since(&LAST_KEY))
        .flatten()
}

/// Seconds since the last physical click, drag, or scroll; `None` when unknown.
pub fn physical_pointer_seconds() -> Option<f64> {
    watch_physical_input();
    HOOKS_READY
        .load(Ordering::SeqCst)
        .then(|| seconds_since(&LAST_POINTER))
        .flatten()
}

// Win32 coordinates are signed physical pixels. Saturation/rounding matches the API.
#[allow(clippy::cast_possible_truncation)]
fn screen_coordinate(value: f64) -> i32 {
    value.round() as i32
}

fn control_role(kind: i32) -> &'static str {
    match kind {
        50000 | 50031 => "Button",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50023 => "Tree",
        50024 | 50029 => "DataItem",
        50026 => "Group",
        50028 => "DataGrid",
        50030 => "Document",
        50032 => "Window",
        _ => "Pane",
    }
}

/// The package identity, when this is a Store application.
pub fn process_aumid(pid: u32) -> Option<String> {
    use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    // SAFETY: a limited-query handle is closed on every path, and Windows sizes
    // the output buffer before writing UTF-16 into its allocated capacity.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut len = 0;
        let _ = GetApplicationUserModelId(process, &raw mut len, None);
        if len == 0 || len > 32768 {
            let _ = CloseHandle(process);
            return None;
        }
        let mut value = vec![0_u16; len as usize];
        let result =
            GetApplicationUserModelId(process, &raw mut len, Some(PWSTR(value.as_mut_ptr())));
        let _ = CloseHandle(process);
        if result.0 != 0 {
            return None;
        }
        Some(String::from_utf16_lossy(
            &value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The invariant the guard exists for: a process the helper shares an integrity
    /// level with is controllable, whether that level is standard or elevated.
    #[test]
    fn own_process_is_controllable() {
        assert!(refuse_elevated(std::process::id()).is_ok());
        assert_eq!(
            token_elevated(unsafe { GetCurrentProcess() }),
            Some(self_elevated())
        );
    }
}
