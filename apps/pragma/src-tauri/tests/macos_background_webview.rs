//! Native regression for first-use cursor overlays stealing app focus.
//! Opt in with `PRAGMA_NATIVE_FOCUS_TEST=1`; requires an interactive macOS desktop.

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    use objc2_app_kit::NSWorkspace;
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if std::env::var_os("PRAGMA_NATIVE_FOCUS_TEST").is_none() {
        eprintln!(
            "SKIP macos_background_webview: set PRAGMA_NATIVE_FOCUS_TEST=1 on a live desktop"
        );
        return;
    }
    // Bound unavailable WindowServer/LaunchServices connections as well as bugs.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(15));
        eprintln!("FAIL: native focus test timed out");
        std::process::exit(1);
    });
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build native webview test app");
    let frontmost = || {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .expect("a foreground application")
            .processIdentifier()
    };
    let exit = app.run_return(move |app, event| {
        if !matches!(event, tauri::RunEvent::Ready) {
            return;
        }
        let before = frontmost();
        assert_ne!(
            i64::from(before),
            i64::from(std::process::id()),
            "run this test with another app in the foreground"
        );
        // The real desktop already has its main window before any overlay.
        // Give AppKit a normal startup window so launch activation is fulfilled
        // before restoring the user's app and testing background overlays.
        WebviewWindowBuilder::new(
            app,
            "main",
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .title("Pragma native focus regression")
        .inner_size(240.0, 100.0)
        .build()
        .unwrap();
        // Tao activates every test app once at launch. Let that settle and
        // restore the original app before testing first-use overlay creation.
        after_native_events(app, move |app| {
            pragma_platform::desktop::focus_app(u64::try_from(before).unwrap()).unwrap();
            after_native_events(&app, move |app| {
                assert_eq!(frontmost(), before, "restore the original foreground app");
                check_overlay(&app, before, 0);
            });
        });
    });
    assert_eq!(exit, 0);
    println!("PASS: creating and showing first and subsequent overlays preserved app focus");
}

#[cfg(target_os = "macos")]
fn check_overlay(app: &tauri::AppHandle, before: i32, index: usize) {
    use objc2_app_kit::NSWorkspace;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let frontmost = || {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .unwrap()
            .processIdentifier()
    };
    let overlay = WebviewWindowBuilder::new(
        app,
        format!("background-overlay-{index}"),
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .build()
    .expect("create hidden cursor overlay");
    overlay.set_ignore_cursor_events(true).unwrap();
    after_native_events(app, move |app| {
        assert_eq!(
            frontmost(),
            before,
            "creating hidden overlay stole app focus"
        );
        overlay.show().unwrap();
        after_native_events(&app, move |app| {
            assert_eq!(frontmost(), before, "showing overlay stole app focus");
            if index == 0 {
                check_overlay(&app, before, 1);
            } else {
                app.exit(0);
            }
        });
    });
}

#[cfg(target_os = "macos")]
fn after_native_events(
    app: &tauri::AppHandle,
    action: impl FnOnce(tauri::AppHandle) + Send + 'static,
) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // Allow asynchronous activation/show requests to reach WindowServer.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let callback_handle = handle.clone();
        handle
            .run_on_main_thread(move || action(callback_handle))
            .unwrap();
    });
}
