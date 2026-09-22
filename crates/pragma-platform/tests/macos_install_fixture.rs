//! End-to-end run of the macOS in-place update against throwaway bundles.
//!
//! Builds a dummy `.app`, packs it into a real disk image with `hdiutil`, and
//! installs it over a second dummy bundle in a temp directory — the same
//! `prepare` + detached helper path a restart update takes, including the
//! relaunch through `open`. Nothing outside the temp directory is touched.
//!
//! Ignored by default because it mounts a disk image and asks `LaunchServices` to
//! open an app: `cargo test -p pragma-platform --test macos_install_fixture -- --ignored`.
#![cfg(target_os = "macos")]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use pragma_platform::install;
use pragma_platform::process;

/// A bundle whose executable records that it was launched, then exits.
fn dummy_app(bundle: &Path, version: &str, launched_marker: &Path) {
    let macos = bundle.join("Contents").join("MacOS");
    fs::create_dir_all(&macos).expect("bundle dirs");
    fs::write(
        bundle.join("Contents").join("Info.plist"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>pragma</string>
  <key>CFBundleIdentifier</key><string>sh.pragma.update-fixture</string>
  <key>CFBundleName</key><string>PragmaFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
"#
        ),
    )
    .expect("Info.plist");
    fs::write(bundle.join("Contents").join("version"), version).expect("version");
    let exe = macos.join("pragma");
    fs::write(
        &exe,
        format!(
            "#!/bin/sh\nprintf '%s' '{version}' > '{}'\n",
            launched_marker.display()
        ),
    )
    .expect("executable");
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).expect("chmod");
}

#[test]
#[ignore = "mounts a disk image and relaunches a dummy app; run explicitly"]
fn installs_a_disk_image_over_a_running_bundle_and_relaunches() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = pragma_platform::path::canonicalize(dir.path()).expect("canonical tempdir");
    let launched = root.join("launched");

    // The update: a new bundle inside a real disk image, with the usual
    // `Applications` symlink beside it.
    let image_src = root.join("image-src");
    dummy_app(&image_src.join("Pragma.app"), "2.0.0", &launched);
    std::os::unix::fs::symlink("/Applications", image_src.join("Applications")).expect("symlink");
    let image = root.join("updates").join("Pragma-2.0.0.dmg");
    fs::create_dir_all(image.parent().expect("parent")).expect("updates dir");
    let created = process::command("/usr/bin/hdiutil")
        .args([
            "create",
            "-quiet",
            "-format",
            "UDZO",
            "-volname",
            "PragmaFixture",
        ])
        .arg("-srcfolder")
        .arg(&image_src)
        .arg(&image)
        .status()
        .expect("hdiutil create");
    assert!(created.success(), "hdiutil create failed");

    // The installed app, in a folder that is not /Applications.
    let installed = root.join("Apps").join("Pragma.app");
    dummy_app(&installed, "1.0.0", &launched);
    let exe = installed.join("Contents").join("MacOS").join("pragma");

    // Stands in for the running app: the helper must wait for it to exit.
    let mut app = process::command("/bin/sleep")
        .arg("1")
        .spawn()
        .expect("stand-in");
    let app_pid = app.id();
    let reaper = std::thread::spawn(move || app.wait());

    let scratch = image.parent().expect("scratch");
    let log = scratch.join("install.log");
    let helper = install::prepare(&image, &exe, scratch, app_pid, &log).expect("prepare");
    let staged = root.join("Apps").join(".Pragma.app.update");
    assert!(
        staged.join("Contents").join("Info.plist").is_file(),
        "the new bundle is staged before the app quits"
    );
    assert_eq!(
        fs::read_to_string(installed.join("Contents").join("version")).expect("version"),
        "1.0.0",
        "nothing is replaced while the app is still running"
    );
    install::spawn_helper(&helper).expect("spawn helper");
    reaper.join().expect("reaper").expect("stand-in exit");

    let deadline = Instant::now() + Duration::from_secs(30);
    while fs::read_to_string(&launched).ok().as_deref() != Some("2.0.0") {
        assert!(
            Instant::now() < deadline,
            "the new bundle was not relaunched; log:\n{}",
            fs::read_to_string(&log).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        fs::read_to_string(installed.join("Contents").join("version")).expect("version"),
        "2.0.0"
    );
    assert!(!staged.exists(), "staged copy was moved into place");
    assert!(
        !root.join("Apps").join(".Pragma.app.previous").exists(),
        "old bundle was removed"
    );
    let log = fs::read_to_string(&log).expect("log");
    assert!(log.contains("installed the new app"), "{log}");
    let mounts = process::command("/usr/bin/hdiutil")
        .arg("info")
        .output()
        .expect("hdiutil info");
    assert!(
        !String::from_utf8_lossy(&mounts.stdout).contains(&*image.to_string_lossy()),
        "the disk image was detached"
    );
}
