//! Actions on the app's dock / taskbar icon ("New Pragma Mini Window").
//!
//! Every desktop exposes a right-click menu on the running app's icon, and each
//! fills it a different way:
//!
//! - **macOS** — the dock asks the application delegate for a menu
//!   (`applicationDockMenu:`). tao owns that delegate and does not implement the
//!   method, so [`install`] adds it to the delegate's class at runtime, plus one
//!   action method the menu items target. Selecting an item calls `on_select`
//!   on the main thread with the action's [`DockAction::arg`].
//! - **Windows** — the taskbar jump list. Its "Tasks" are shell links that start
//!   the executable again with [`DockAction::arg`]; the single-instance guard
//!   forwards that argv to the running app, which is where the caller must route
//!   it. `on_select` is never called here.
//! - **Linux** — `Actions=` in the bundle's `.desktop` entry, written by the
//!   bundler from `src-tauri/linux/pragma.desktop` (they cannot be added at
//!   runtime). Like Windows they relaunch the executable with the argument, so
//!   [`install`] reports [`DockInstall::DesktopEntry`] rather than doing
//!   anything — an explicit answer, not a quiet no-op.
//!
//! This is the one seam that needs `unsafe`: there is no safe binding for adding
//! a method to an existing Objective-C class, and the jump list is a COM API.
//! Both blocks are confined to this file and documented at each use.

use thiserror::Error;

/// One entry in the icon's menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockAction {
    /// Visible label.
    pub title: String,
    /// Identifies the action: passed to `on_select` on macOS, and used as the
    /// relaunch argument on Windows and Linux.
    pub arg: String,
}

/// How the actions reached the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockInstall {
    /// Installed at runtime (macOS dock menu, Windows jump list).
    Installed,
    /// Declared statically by the bundle's `.desktop` entry (Linux).
    DesktopEntry,
}

/// Errors raised while installing the icon menu.
#[derive(Debug, Error)]
pub enum DockError {
    /// Called off the main thread, where `AppKit` refuses menu work.
    #[error("the dock menu must be installed from the main thread")]
    NotMainThread,
    /// The application has no delegate yet (called before the event loop ran).
    #[error("the application has no delegate to attach a dock menu to")]
    NoDelegate,
    /// [`install`] was already called once for this process.
    #[error("the dock menu is already installed")]
    AlreadyInstalled,
    /// The OS rejected the request.
    #[error("installing the dock menu failed: {0}")]
    Os(String),
}

/// Callback invoked with [`DockAction::arg`] when a dock-menu item is chosen.
pub type DockHandler = Box<dyn Fn(&str) + Send + Sync + 'static>;

/// Installs `actions` on the running app's dock or taskbar icon.
///
/// # Errors
///
/// Returns a [`DockError`] when the platform API refuses the menu. A failure is
/// never fatal for the app; callers log it.
pub fn install(actions: &[DockAction], on_select: DockHandler) -> Result<DockInstall, DockError> {
    imp::install(actions, on_select)
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    //! `applicationDockMenu:` on tao's application delegate.

    use std::cell::RefCell;
    use std::sync::OnceLock;

    use objc2::ffi::class_addMethod;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
    use objc2_foundation::NSString;

    use super::{DockAction, DockError, DockHandler, DockInstall};

    /// Action ids by menu-item tag, plus the caller's handler.
    static HANDLER: OnceLock<(Vec<String>, DockHandler)> = OnceLock::new();

    thread_local! {
        /// The dock menu, owned on the main thread (an `NSMenu` is not `Send`).
        static MENU: RefCell<Option<Retained<NSMenu>>> = const { RefCell::new(None) };
    }

    pub(super) fn install(
        actions: &[DockAction],
        on_select: DockHandler,
    ) -> Result<DockInstall, DockError> {
        let mtm = MainThreadMarker::new().ok_or(DockError::NotMainThread)?;
        let app = NSApplication::sharedApplication(mtm);
        let delegate = app.delegate().ok_or(DockError::NoDelegate)?;
        let ids = actions.iter().map(|action| action.arg.clone()).collect();
        HANDLER
            .set((ids, on_select))
            .map_err(|_| DockError::AlreadyInstalled)?;

        let delegate: &AnyObject = delegate.as_ref();
        let menu = NSMenu::new(mtm);
        for (index, action) in actions.iter().enumerate() {
            let title = NSString::from_str(&action.title);
            let key = NSString::from_str("");
            // SAFETY: `alloc` gives a fresh, uninitialised item; the selector
            // names the action method added to the delegate class below, whose
            // signature (`v@:@`) matches what `NSMenuItem` sends.
            let item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    mtm.alloc(),
                    &title,
                    Some(sel!(pragmaDockMenuItemSelected:)),
                    &key,
                )
            };
            item.setTag(isize::try_from(index).unwrap_or(isize::MAX));
            // SAFETY: the delegate outlives the menu (it lives for the whole
            // app), and it implements the action once `add_methods` returns.
            unsafe { item.setTarget(Some(delegate)) };
            menu.addItem(&item);
        }
        add_methods(delegate.class())?;
        MENU.with(|slot| *slot.borrow_mut() = Some(menu));
        Ok(DockInstall::Installed)
    }

    fn add_methods(class: &AnyClass) -> Result<(), DockError> {
        let class = std::ptr::from_ref(class).cast_mut();
        // SAFETY: each `Imp` is cast from an `extern "C-unwind"` function whose
        // parameters match its type encoding exactly: `@@:@` returns an object
        // from (self, _cmd, sender), `v@:@` returns nothing. `class_addMethod`
        // only adds a method that the class does not already define, so tao's
        // own methods are never replaced.
        let added = unsafe {
            let dock_menu: Imp = std::mem::transmute::<
                extern "C-unwind" fn(&AnyObject, Sel, &AnyObject) -> *mut NSMenu,
                Imp,
            >(application_dock_menu);
            let selected: Imp = std::mem::transmute::<
                extern "C-unwind" fn(&AnyObject, Sel, &NSMenuItem),
                Imp,
            >(dock_item_selected);
            class_addMethod(
                class,
                sel!(applicationDockMenu:),
                dock_menu,
                c"@@:@".as_ptr(),
            )
            .as_bool()
                && class_addMethod(
                    class,
                    sel!(pragmaDockMenuItemSelected:),
                    selected,
                    c"v@:@".as_ptr(),
                )
                .as_bool()
        };
        if added {
            Ok(())
        } else {
            Err(DockError::Os(
                "the application delegate already defines a dock menu".to_string(),
            ))
        }
    }

    /// `-[delegate applicationDockMenu:]`: returns the menu at +0, as `AppKit`
    /// expects; the thread-local keeps it alive.
    extern "C-unwind" fn application_dock_menu(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: &AnyObject,
    ) -> *mut NSMenu {
        MENU.with(|slot| {
            slot.borrow().as_ref().map_or(std::ptr::null_mut(), |menu| {
                Retained::as_ptr(menu).cast_mut()
            })
        })
    }

    /// `-[delegate pragmaDockMenuItemSelected:]`: forwards the chosen item.
    extern "C-unwind" fn dock_item_selected(_this: &AnyObject, _cmd: Sel, item: &NSMenuItem) {
        let Some((ids, handler)) = HANDLER.get() else {
            return;
        };
        if let Some(id) = usize::try_from(item.tag())
            .ok()
            .and_then(|tag| ids.get(tag))
        {
            handler(id);
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod imp {
    //! Taskbar jump-list tasks (`ICustomDestinationList::AddUserTasks`).

    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    use super::{DockAction, DockError, DockHandler, DockInstall};

    pub(super) fn install(
        actions: &[DockAction],
        _on_select: DockHandler,
    ) -> Result<DockInstall, DockError> {
        let exe = std::env::current_exe().map_err(|error| DockError::Os(error.to_string()))?;
        let exe = HSTRING::from(exe.as_os_str());
        let actions = actions.to_vec();
        // A thread of its own gets a COM apartment we own outright, instead of
        // inheriting whatever the UI thread's webview initialised.
        std::thread::spawn(move || {
            // SAFETY: balanced with `CoUninitialize` below on this same thread.
            let initialised = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
            let result = build_jump_list(&exe, &actions);
            if initialised {
                // SAFETY: this thread initialised COM above.
                unsafe { CoUninitialize() };
            }
            result
        })
        .join()
        .map_err(|_| DockError::Os("the jump-list thread panicked".to_string()))?
        .map_err(|error| DockError::Os(error.message()))?;
        Ok(DockInstall::Installed)
    }

    fn build_jump_list(exe: &HSTRING, actions: &[DockAction]) -> windows::core::Result<()> {
        // SAFETY: plain COM calls on interfaces created here; every pointer
        // argument is a live local, and the list is committed before return.
        unsafe {
            let list: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            let mut min_slots = 0u32;
            let _removed: IObjectArray = list.BeginList(&raw mut min_slots)?;
            let tasks: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for action in actions {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(exe)?;
                link.SetArguments(&HSTRING::from(action.arg.as_str()))?;
                link.SetIconLocation(exe, 0)?;
                link.SetDescription(&HSTRING::from(action.title.as_str()))?;
                let store: IPropertyStore = link.cast()?;
                store.SetValue(&PKEY_Title, &PROPVARIANT::from(action.title.as_str()))?;
                store.Commit()?;
                tasks.AddObject(&link)?;
            }
            list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
            list.CommitList()
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    //! Linux: the `.desktop` entry declares the actions.

    use super::{DockAction, DockError, DockHandler, DockInstall};

    #[allow(clippy::unnecessary_wraps)] // Same signature as the other platforms.
    pub(super) fn install(
        _actions: &[DockAction],
        _on_select: DockHandler,
    ) -> Result<DockInstall, DockError> {
        Ok(DockInstall::DesktopEntry)
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_to_install_off_the_main_thread() {
        // Test threads are never the process main thread.
        let result = install(
            &[DockAction {
                title: "New".to_string(),
                arg: "--new".to_string(),
            }],
            Box::new(|_| {}),
        );
        assert!(matches!(result, Err(DockError::NotMainThread)));
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn linux_defers_to_the_desktop_entry() {
        let result = install(&[], Box::new(|_| {}));
        assert_eq!(result.unwrap(), DockInstall::DesktopEntry);
    }
}
