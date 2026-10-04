//! Replacing the installed desktop app with a downloaded build, then relaunching it.
//!
//! A running app cannot reliably overwrite and restart itself, so the last step
//! always belongs to a small detached helper that outlives it: the helper waits
//! for the app's pid to exit, finishes the install, and launches the new build.
//! Each OS installs differently:
//!
//! - **macOS** ships a disk image. The new bundle is copied out of the image
//!   (mounted read-only, never shown in Finder) to a hidden sibling of the
//!   installed bundle *while the app still runs*, so a failure there can still
//!   be reported. After the app exits the helper swaps the two by rename —
//!   atomic on one volume, and a running `pragma-server` keeps its open image —
//!   and relaunches with `open`.
//! - **Windows** ships the per-user NSIS `-setup.exe`. Windows locks the image
//!   of a running executable, so it only runs (silently, `/S`) after the app has
//!   exited; its `installer-hooks.nsh` stops the sidecars the same way it does
//!   for a manual install. The per-machine MSI is never offered here and keeps
//!   relying on Restart Manager.
//! - **Linux** ships a `.deb` or `.rpm`. It is installed as root through
//!   `pkexec` while the app still runs — package managers replace files by
//!   rename, so the running binary is unaffected — which lets a missing
//!   `pkexec` or a cancelled prompt be reported instead of leaving the user with
//!   no app. The helper then only waits and relaunches.
//!
//! Which of these applies is decided by the installer file, never by `cfg`: the
//! update check already picked the asset built for this platform. Everything
//! that decides ([`plan_install`], [`helper_command`], [`app_bundle_for_executable`])
//! is a pure function over a [`Host`], so every platform's plan is tested on
//! every platform. The functions that act ([`prepare`], [`spawn_helper`]) only
//! run what was planned.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use crate::{process, shell};

/// The kind of installer a downloaded update asset is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallerKind {
    /// A macOS `.dmg` holding the `.app` bundle.
    DiskImage,
    /// The Windows per-user NSIS `-setup.exe`.
    NsisSetup,
    /// A Debian/Ubuntu `.deb`.
    DebPackage,
    /// A Fedora/RHEL/SUSE `.rpm`.
    RpmPackage,
}

impl InstallerKind {
    /// Classifies an installer by its file name; `None` for anything that is
    /// not installed in place (an `.msi`, an `.AppImage`, an unknown file).
    #[must_use]
    pub fn from_path(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        match extension.as_str() {
            "dmg" => Some(Self::DiskImage),
            "exe" => Some(Self::NsisSetup),
            "deb" => Some(Self::DebPackage),
            "rpm" => Some(Self::RpmPackage),
            _ => None,
        }
    }
}

/// What the running machine can do, asked through a trait so plans are testable.
pub trait Host {
    /// Whether a new entry can be created (and renamed) inside `dir`.
    fn is_writable(&self, dir: &Path) -> bool;
    /// Absolute path of a program on `PATH`, if it is installed.
    fn find_program(&self, name: &str) -> Option<PathBuf>;
}

/// The real machine.
#[derive(Clone, Copy, Debug, Default)]
pub struct LiveHost;

impl Host for LiveHost {
    fn is_writable(&self, dir: &Path) -> bool {
        // Permission bits do not answer this on their own (ACLs, read-only
        // mounts, App Translocation), so probe with a real create.
        let probe = dir.join(format!(".pragma-update-probe-{}", std::process::id()));
        let created = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .is_ok();
        if created {
            let _ = fs::remove_file(&probe);
        }
        created
    }

    fn find_program(&self, name: &str) -> Option<PathBuf> {
        shell::find_on_path(name)
    }
}

/// A program, its arguments, and its environment, fully decided up front.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedCommand {
    /// Absolute path of the program to run.
    pub program: PathBuf,
    /// Arguments, passed as-is (never through a shell's word splitting).
    pub args: Vec<OsString>,
    /// Extra environment variables.
    pub envs: Vec<(String, OsString)>,
}

impl PlannedCommand {
    fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            envs: Vec::new(),
        }
    }

    fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.args.push(arg.as_ref().to_os_string());
        self
    }

    fn env(mut self, key: &str, value: impl AsRef<OsStr>) -> Self {
        self.envs
            .push((key.to_string(), value.as_ref().to_os_string()));
        self
    }

    /// The value of one planned environment variable.
    #[must_use]
    pub fn env_value(&self, key: &str) -> Option<&OsStr> {
        self.envs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_os_str())
    }

    /// A windowless [`Command`] for this plan.
    #[must_use]
    pub fn to_command(&self) -> Command {
        let mut command = process::command(&self.program);
        command.args(&self.args);
        command.envs(self.envs.iter().map(|(key, value)| (key, value)));
        command
    }
}

/// The package manager that installs a Linux package.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageTool {
    /// `apt-get install -y /abs/file.deb` — resolves dependencies, unlike `dpkg -i`.
    AptGet,
    /// `dnf install -y /abs/file.rpm`.
    Dnf,
    /// `rpm -U /abs/file.rpm`, where dnf is absent.
    Rpm,
}

impl PackageTool {
    fn program(self) -> &'static str {
        match self {
            Self::AptGet => "apt-get",
            Self::Dnf => "dnf",
            Self::Rpm => "rpm",
        }
    }

    /// Arguments that install `package`, which must be an absolute path: apt
    /// only treats an argument containing a `/` as a file rather than a name.
    fn install_args(self, package: &Path) -> Vec<OsString> {
        let flags: &[&str] = match self {
            Self::AptGet | Self::Dnf => &["install", "-y"],
            Self::Rpm => &["-U"],
        };
        flags
            .iter()
            .map(OsString::from)
            .chain([package.as_os_str().to_os_string()])
            .collect()
    }
}

/// Paths of a macOS in-place bundle replacement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleSwap {
    /// The verified disk image.
    pub image: PathBuf,
    /// The installed bundle the app is running from.
    pub bundle: PathBuf,
    /// Hidden sibling the new bundle is copied to before the swap.
    pub staged: PathBuf,
    /// Hidden sibling the old bundle is renamed to during the swap.
    pub backup: PathBuf,
}

impl BundleSwap {
    /// The staged/backup siblings for `bundle`, on its own volume so the swap
    /// is a rename, never a copy.
    #[must_use]
    pub fn for_bundle(image: &Path, bundle: &Path) -> Option<Self> {
        let parent = bundle.parent()?;
        let name = bundle.file_name()?.to_str()?;
        Some(Self {
            image: image.to_path_buf(),
            bundle: bundle.to_path_buf(),
            staged: parent.join(format!(".{name}.update")),
            backup: parent.join(format!(".{name}.previous")),
        })
    }
}

/// How a restart update will be installed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InstallPlan {
    /// macOS: stage the bundle from the image now, swap it in after exit.
    SwapBundle(BundleSwap),
    /// Windows: run the NSIS setup silently after exit, then relaunch `app`.
    SilentSetup {
        /// The verified `-setup.exe`.
        setup: PathBuf,
        /// The installed executable to relaunch.
        app: PathBuf,
        /// Absolute path of `powershell.exe`, which runs the helper.
        powershell: PathBuf,
    },
    /// Linux: run `install` (through `pkexec`) now, relaunch `app` after exit.
    ElevatedPackage {
        /// The `pkexec <tool> …` invocation.
        install: PlannedCommand,
        /// Tool the package is installed with, for messages.
        tool: PackageTool,
        /// The installed executable to relaunch.
        app: PathBuf,
    },
}

/// Why an update cannot be installed in place; the caller opens the installer instead.
#[derive(Debug, thiserror::Error)]
pub enum InstallFallback {
    /// The installer type is never installed in place.
    #[error("{0} installers are not installed in place")]
    UnsupportedInstaller(String),
    /// The app is not running from an `.app` bundle.
    #[error("the app is not running from an .app bundle ({0})")]
    NotInAppBundle(PathBuf),
    /// The folder holding the installed app cannot be written.
    #[error("{0} is not writable")]
    NotWritable(PathBuf),
    /// A program the install needs is not installed.
    #[error("{0} is not installed")]
    MissingProgram(&'static str),
    /// The administrator prompt was dismissed or refused.
    #[error("the administrator prompt was cancelled")]
    Cancelled,
    /// A step of the install ran and failed.
    #[error("{step} failed: {detail}")]
    Failed {
        /// What was being done.
        step: &'static str,
        /// The underlying error or exit status.
        detail: String,
    },
}

impl InstallFallback {
    fn failed(step: &'static str, detail: impl fmt::Display) -> Self {
        Self::Failed {
            step,
            detail: detail.to_string(),
        }
    }
}

/// Environment keys the helper scripts read. Values never pass through a
/// shell's word splitting or a PowerShell parse, so no path needs quoting.
const ENV_PID: &str = "PRAGMA_UPDATE_PID";
const ENV_LOG: &str = "PRAGMA_UPDATE_LOG";
const ENV_TARGET: &str = "PRAGMA_UPDATE_TARGET";
const ENV_STAGED: &str = "PRAGMA_UPDATE_STAGED";
const ENV_BACKUP: &str = "PRAGMA_UPDATE_BACKUP";
const ENV_INSTALLER: &str = "PRAGMA_UPDATE_INSTALLER";
const ENV_APP: &str = "PRAGMA_UPDATE_APP";

/// `pkexec` exits 126 when its prompt is dismissed and 127 when authorization
/// fails; both mean "the user said no", not "the package is broken".
const PKEXEC_REFUSED: [i32; 2] = [126, 127];

/// POSIX helper: wait for the app to exit, optionally swap a staged bundle into
/// place (restoring the old one if the second rename fails), then `exec "$@"`.
const UNIX_HELPER: &str = r#"log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$PRAGMA_UPDATE_LOG"; }
tries=0
while kill -0 "$PRAGMA_UPDATE_PID" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 600 ]; then
    log "the app did not quit; update abandoned"
    if [ -n "${PRAGMA_UPDATE_STAGED:-}" ]; then rm -rf "$PRAGMA_UPDATE_STAGED"; fi
    exit 1
  fi
  sleep 0.2
done
if [ -n "${PRAGMA_UPDATE_STAGED:-}" ]; then
  rm -rf "$PRAGMA_UPDATE_BACKUP"
  if ! mv "$PRAGMA_UPDATE_TARGET" "$PRAGMA_UPDATE_BACKUP"; then
    log "could not move the installed app aside; keeping it"
    rm -rf "$PRAGMA_UPDATE_STAGED"
  elif ! mv "$PRAGMA_UPDATE_STAGED" "$PRAGMA_UPDATE_TARGET"; then
    log "could not move the new app into place; restoring the old one"
    mv "$PRAGMA_UPDATE_BACKUP" "$PRAGMA_UPDATE_TARGET"
  else
    rm -rf "$PRAGMA_UPDATE_BACKUP"
    log "installed the new app"
  fi
fi
log "relaunching"
exec "$@"
"#;

/// Windows helper: wait for the app to exit, run the NSIS setup silently, then
/// relaunch. The NSIS hook stops the sidecars itself (`/S` never prompts).
const WINDOWS_HELPER: &str = r"$ErrorActionPreference = 'Continue'
function Write-Log($message) { Add-Content -LiteralPath $env:PRAGMA_UPDATE_LOG -Value ((Get-Date -Format s) + ' ' + $message) }
$app = Get-Process -Id ([int]$env:PRAGMA_UPDATE_PID) -ErrorAction SilentlyContinue
if ($app -and -not $app.WaitForExit(120000)) { Write-Log 'the app did not quit; update abandoned'; exit 1 }
try {
  $setup = Start-Process -FilePath $env:PRAGMA_UPDATE_INSTALLER -ArgumentList '/S' -Wait -PassThru
  Write-Log ('installer exited with ' + $setup.ExitCode)
} catch {
  Write-Log ('installer could not start: ' + $_)
}
Write-Log 'relaunching'
Start-Process -FilePath $env:PRAGMA_UPDATE_APP
";

const SH: &str = "/bin/sh";
const OPEN: &str = "/usr/bin/open";
const HDIUTIL: &str = "/usr/bin/hdiutil";
const DITTO: &str = "/usr/bin/ditto";

/// The `.app` bundle an executable inside `Name.app/Contents/MacOS/` belongs to.
#[must_use]
pub fn app_bundle_for_executable(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    is_bundle.then(|| bundle.to_path_buf())
}

/// Decides how to install `installer` over the app running as `current_exe`.
///
/// `current_exe` must be resolved (canonical) and captured **before** anything
/// is installed: once a Linux package replaces the file, `/proc/self/exe` reads
/// back as `… (deleted)`.
///
/// # Errors
///
/// An [`InstallFallback`] naming why the update cannot be installed in place.
pub fn plan_install(
    installer: &Path,
    current_exe: &Path,
    host: &impl Host,
) -> Result<InstallPlan, InstallFallback> {
    let kind = InstallerKind::from_path(installer).ok_or_else(|| {
        InstallFallback::UnsupportedInstaller(installer.extension().map_or_else(
            || "extension-less".to_string(),
            |ext| format!(".{}", ext.to_string_lossy()),
        ))
    })?;
    match kind {
        InstallerKind::DiskImage => {
            let bundle = app_bundle_for_executable(current_exe)
                .ok_or_else(|| InstallFallback::NotInAppBundle(current_exe.to_path_buf()))?;
            let swap = BundleSwap::for_bundle(installer, &bundle)
                .ok_or_else(|| InstallFallback::NotInAppBundle(current_exe.to_path_buf()))?;
            let parent = bundle.parent().unwrap_or(&bundle);
            if !host.is_writable(parent) {
                return Err(InstallFallback::NotWritable(parent.to_path_buf()));
            }
            Ok(InstallPlan::SwapBundle(swap))
        }
        InstallerKind::NsisSetup => Ok(InstallPlan::SilentSetup {
            setup: installer.to_path_buf(),
            app: current_exe.to_path_buf(),
            powershell: host
                .find_program("powershell.exe")
                .ok_or(InstallFallback::MissingProgram("powershell.exe"))?,
        }),
        InstallerKind::DebPackage | InstallerKind::RpmPackage => {
            let pkexec = host
                .find_program("pkexec")
                .ok_or(InstallFallback::MissingProgram("pkexec"))?;
            let candidates: &[PackageTool] = if kind == InstallerKind::DebPackage {
                &[PackageTool::AptGet]
            } else {
                &[PackageTool::Dnf, PackageTool::Rpm]
            };
            let (tool, tool_path) = candidates
                .iter()
                .find_map(|tool| Some((*tool, host.find_program(tool.program())?)))
                .ok_or(InstallFallback::MissingProgram(candidates[0].program()))?;
            let mut install = PlannedCommand::new(pkexec).arg(tool_path);
            install.args.extend(tool.install_args(installer));
            Ok(InstallPlan::ElevatedPackage {
                install,
                tool,
                app: current_exe.to_path_buf(),
            })
        }
    }
}

/// The detached helper that finishes `plan` once process `app_pid` has exited,
/// appending what it did to `log`.
#[must_use]
pub fn helper_command(plan: &InstallPlan, app_pid: u32, log: &Path) -> PlannedCommand {
    match plan {
        InstallPlan::SwapBundle(swap) => unix_helper(app_pid, log)
            .env(ENV_TARGET, &swap.bundle)
            .env(ENV_STAGED, &swap.staged)
            .env(ENV_BACKUP, &swap.backup)
            .arg(OPEN)
            .arg(&swap.bundle),
        InstallPlan::ElevatedPackage { app, .. } => unix_helper(app_pid, log).arg(app),
        InstallPlan::SilentSetup {
            setup,
            app,
            powershell,
        } => PlannedCommand::new(powershell)
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-WindowStyle")
            .arg("Hidden")
            .arg("-Command")
            .arg(WINDOWS_HELPER)
            .env(ENV_PID, app_pid.to_string())
            .env(ENV_LOG, log)
            .env(ENV_INSTALLER, setup)
            .env(ENV_APP, app),
    }
}

/// `sh -c <helper> sh <relaunch argv…>`: the relaunch command arrives as `"$@"`.
fn unix_helper(app_pid: u32, log: &Path) -> PlannedCommand {
    PlannedCommand::new(SH)
        .arg("-c")
        .arg(UNIX_HELPER)
        .arg("sh")
        .env(ENV_PID, app_pid.to_string())
        .env(ENV_LOG, log)
}

/// Plans the install and does everything that must happen while the app still
/// runs, returning the helper to start just before it quits.
///
/// `scratch` is a directory this may use for a disk-image mount point.
///
/// # Errors
///
/// An [`InstallFallback`] when the update cannot be installed in place; nothing
/// has been changed on disk except scratch files, and the caller should open
/// the installer for the user instead.
pub fn prepare(
    installer: &Path,
    current_exe: &Path,
    scratch: &Path,
    app_pid: u32,
    log: &Path,
) -> Result<PlannedCommand, InstallFallback> {
    let plan = plan_install(installer, current_exe, &LiveHost)?;
    match &plan {
        InstallPlan::SwapBundle(swap) => stage_bundle(swap, scratch)?,
        InstallPlan::ElevatedPackage { install, tool, .. } => run_elevated(install, *tool)?,
        InstallPlan::SilentSetup { .. } => {}
    }
    Ok(helper_command(&plan, app_pid, log))
}

/// Starts the helper detached, so it outlives the app.
///
/// # Errors
///
/// The spawn error, when the helper could not be started.
pub fn spawn_helper(helper: &PlannedCommand) -> io::Result<()> {
    let mut command = helper.to_command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    process::detach(&mut command);
    // Deliberately not waited on: the app exits right after this.
    command.spawn().map(drop)
}

/// Removes what [`prepare`] staged, when the helper could not be started.
pub fn discard_staged(helper: &PlannedCommand) {
    if let Some(staged) = helper.env_value(ENV_STAGED) {
        let _ = fs::remove_dir_all(staged);
    }
}

/// Copies the new bundle out of the disk image to `swap.staged`.
fn stage_bundle(swap: &BundleSwap, scratch: &Path) -> Result<(), InstallFallback> {
    let mount = scratch.join(format!("mount-{}", std::process::id()));
    fs::create_dir_all(&mount)
        .map_err(|error| InstallFallback::failed("creating a mount point", error))?;
    run(
        "mounting the disk image",
        &PlannedCommand::new(HDIUTIL)
            .arg("attach")
            .arg("-nobrowse")
            .arg("-readonly")
            .arg("-noautoopen")
            .arg("-mountpoint")
            .arg(&mount)
            .arg(&swap.image),
    )?;
    let copied = copy_bundle_from_image(&mount, swap);
    let detached = run(
        "detaching the disk image",
        &PlannedCommand::new(HDIUTIL).arg("detach").arg(&mount),
    )
    .or_else(|_| {
        run(
            "detaching the disk image",
            &PlannedCommand::new(HDIUTIL)
                .arg("detach")
                .arg("-force")
                .arg(&mount),
        )
    });
    let _ = fs::remove_dir(&mount);
    if copied.is_err() {
        let _ = fs::remove_dir_all(&swap.staged);
    }
    copied?;
    // A copy that succeeded is usable even if the image is left mounted.
    drop(detached);
    Ok(())
}

fn copy_bundle_from_image(mount: &Path, swap: &BundleSwap) -> Result<(), InstallFallback> {
    let entries: Vec<String> = fs::read_dir(mount)
        .map_err(|error| InstallFallback::failed("reading the disk image", error))?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    let preferred = swap
        .bundle
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    let app = pick_app_in_image(&entries, preferred).ok_or_else(|| {
        InstallFallback::failed("reading the disk image", "it holds no single .app bundle")
    })?;
    if swap.staged.exists() {
        fs::remove_dir_all(&swap.staged)
            .map_err(|error| InstallFallback::failed("clearing a previous staged copy", error))?;
    }
    // `ditto` keeps code signatures, extended attributes, and symlinks intact.
    run(
        "copying the new app",
        &PlannedCommand::new(DITTO)
            .arg(mount.join(app))
            .arg(&swap.staged),
    )?;
    if !swap.staged.join("Contents").join("Info.plist").is_file() {
        return Err(InstallFallback::failed(
            "copying the new app",
            "the copied bundle has no Contents/Info.plist",
        ));
    }
    Ok(())
}

/// The bundle to install from a mounted image: the one named like the installed
/// bundle, else the only `.app` there. The image also holds an `Applications`
/// symlink, which is not an `.app`.
#[must_use]
pub fn pick_app_in_image<'a>(entries: &'a [String], preferred: &str) -> Option<&'a str> {
    if let Some(entry) = entries.iter().find(|entry| *entry == preferred) {
        return Some(entry);
    }
    let mut apps = entries.iter().filter(|entry| {
        Path::new(entry.as_str())
            .extension()
            .is_some_and(|ext| ext == "app")
    });
    match (apps.next(), apps.next()) {
        (Some(app), None) => Some(app),
        _ => None,
    }
}

fn run_elevated(install: &PlannedCommand, tool: PackageTool) -> Result<(), InstallFallback> {
    let status = install
        .to_command()
        .stdin(Stdio::null())
        .status()
        .map_err(|error| InstallFallback::failed("starting pkexec", error))?;
    elevated_outcome(status.code(), tool.program(), status)
}

/// Maps a finished `pkexec` run to success, a cancellation, or a failure.
fn elevated_outcome(
    code: Option<i32>,
    tool: &str,
    status: impl fmt::Display,
) -> Result<(), InstallFallback> {
    match code {
        Some(0) => Ok(()),
        Some(code) if PKEXEC_REFUSED.contains(&code) => Err(InstallFallback::Cancelled),
        _ => Err(InstallFallback::Failed {
            step: "installing the package",
            detail: format!("{tool} exited with {status}"),
        }),
    }
}

fn run(step: &'static str, planned: &PlannedCommand) -> Result<(), InstallFallback> {
    let output = planned
        .to_command()
        .stdin(Stdio::null())
        .output()
        .map_err(|error| InstallFallback::failed(step, error))?;
    if output.status.success() {
        return Ok(());
    }
    Err(InstallFallback::failed(
        step,
        describe_failure(output.status, &output.stderr),
    ))
}

fn describe_failure(status: ExitStatus, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        status.to_string()
    } else {
        format!("{status}: {stderr}")
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    use super::{
        app_bundle_for_executable, elevated_outcome, helper_command, pick_app_in_image,
        plan_install, BundleSwap, Host, InstallFallback, InstallPlan, InstallerKind, PackageTool,
        ENV_APP, ENV_BACKUP, ENV_INSTALLER, ENV_LOG, ENV_PID, ENV_STAGED, ENV_TARGET, UNIX_HELPER,
        WINDOWS_HELPER,
    };

    #[derive(Default)]
    struct FakeHost {
        writable: bool,
        programs: HashMap<&'static str, PathBuf>,
        probed: RefCell<Vec<PathBuf>>,
    }

    impl FakeHost {
        fn with(programs: &[(&'static str, &str)]) -> Self {
            Self {
                writable: true,
                programs: programs
                    .iter()
                    .map(|(name, path)| (*name, PathBuf::from(path)))
                    .collect(),
                probed: RefCell::default(),
            }
        }
    }

    impl Host for FakeHost {
        fn is_writable(&self, dir: &Path) -> bool {
            self.probed.borrow_mut().push(dir.to_path_buf());
            self.writable
        }

        fn find_program(&self, name: &str) -> Option<PathBuf> {
            self.programs.get(name).cloned()
        }
    }

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn classifies_installers_by_extension() {
        let kind = |name: &str| InstallerKind::from_path(Path::new(name));
        assert_eq!(kind("Pragma-0.6.0.dmg"), Some(InstallerKind::DiskImage));
        assert_eq!(kind("Pragma-0.6.0.exe"), Some(InstallerKind::NsisSetup));
        assert_eq!(kind("Pragma-0.6.0.deb"), Some(InstallerKind::DebPackage));
        assert_eq!(kind("Pragma-0.6.0.RPM"), Some(InstallerKind::RpmPackage));
        assert_eq!(kind("Pragma-0.6.0.msi"), None);
        assert_eq!(kind("Pragma-0.6.0.AppImage"), None);
        assert_eq!(kind("Pragma-0.6.0"), None);
    }

    #[test]
    fn derives_the_bundle_from_the_running_executable() {
        assert_eq!(
            app_bundle_for_executable(Path::new("/Users/me/Apps/Pragma.app/Contents/MacOS/pragma")),
            Some(PathBuf::from("/Users/me/Apps/Pragma.app"))
        );
        assert_eq!(
            app_bundle_for_executable(Path::new(
                "/Applications/Pragma Dev.app/Contents/MacOS/pragma"
            )),
            Some(PathBuf::from("/Applications/Pragma Dev.app"))
        );
        // Not a bundle: a dev build, or a Linux install.
        assert_eq!(
            app_bundle_for_executable(Path::new("/repo/target/debug/pragma")),
            None
        );
        assert_eq!(
            app_bundle_for_executable(Path::new("/usr/bin/pragma")),
            None
        );
        assert_eq!(
            app_bundle_for_executable(Path::new("/x/Pragma/Contents/MacOS/pragma")),
            None
        );
    }

    #[test]
    fn macos_swaps_the_bundle_the_app_runs_from() {
        let host = FakeHost::with(&[]);
        let plan = plan_install(
            Path::new("/data/updates/Pragma-0.6.0.dmg"),
            Path::new("/Users/me/Apps/Pragma.app/Contents/MacOS/pragma"),
            &host,
        )
        .expect("plan");
        let InstallPlan::SwapBundle(swap) = &plan else {
            panic!("expected a bundle swap, got {plan:?}");
        };
        assert_eq!(
            swap,
            &BundleSwap {
                image: PathBuf::from("/data/updates/Pragma-0.6.0.dmg"),
                bundle: PathBuf::from("/Users/me/Apps/Pragma.app"),
                staged: PathBuf::from("/Users/me/Apps/.Pragma.app.update"),
                backup: PathBuf::from("/Users/me/Apps/.Pragma.app.previous"),
            }
        );
        // The rename happens in the bundle's parent, so that is what must be writable.
        assert_eq!(*host.probed.borrow(), vec![PathBuf::from("/Users/me/Apps")]);

        let helper = helper_command(&plan, 4242, Path::new("/data/updates/install.log"));
        assert_eq!(helper.program, PathBuf::from("/bin/sh"));
        assert_eq!(
            helper.args,
            args(&[
                "-c",
                UNIX_HELPER,
                "sh",
                "/usr/bin/open",
                "/Users/me/Apps/Pragma.app"
            ])
        );
        // Paths compare as `Path`, not text: `join` writes `\\` on Windows, where
        // this macOS plan is tested too, and `Path` treats both separators alike.
        assert_eq!(helper.env_value(ENV_PID), Some("4242".as_ref()));
        assert_eq!(
            helper.env_value(ENV_LOG).map(Path::new),
            Some(Path::new("/data/updates/install.log"))
        );
        assert_eq!(
            helper.env_value(ENV_TARGET).map(Path::new),
            Some(Path::new("/Users/me/Apps/Pragma.app"))
        );
        assert_eq!(
            helper.env_value(ENV_STAGED).map(Path::new),
            Some(Path::new("/Users/me/Apps/.Pragma.app.update"))
        );
        assert_eq!(
            helper.env_value(ENV_BACKUP).map(Path::new),
            Some(Path::new("/Users/me/Apps/.Pragma.app.previous"))
        );
    }

    #[test]
    fn macos_falls_back_when_the_bundle_cannot_be_replaced() {
        let read_only = FakeHost {
            writable: false,
            ..FakeHost::default()
        };
        let err = plan_install(
            Path::new("/data/Pragma-0.6.0.dmg"),
            Path::new("/Volumes/Pragma/Pragma.app/Contents/MacOS/pragma"),
            &read_only,
        )
        .expect_err("read-only volume");
        assert!(
            matches!(&err, InstallFallback::NotWritable(dir) if dir == Path::new("/Volumes/Pragma"))
        );
        assert_eq!(err.to_string(), "/Volumes/Pragma is not writable");

        let err = plan_install(
            Path::new("/data/Pragma-0.6.0.dmg"),
            Path::new("/repo/target/release/pragma"),
            &FakeHost::with(&[]),
        )
        .expect_err("not a bundle");
        assert!(matches!(err, InstallFallback::NotInAppBundle(_)));
    }

    #[test]
    fn windows_runs_the_setup_silently_after_exit() {
        let host = FakeHost::with(&[(
            "powershell.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        )]);
        let plan = plan_install(
            Path::new(r"C:\Users\me\AppData\Roaming\sh.pragma\updates\Pragma-0.6.0.exe"),
            Path::new(r"C:\Users\me\AppData\Local\Pragma\pragma.exe"),
            &host,
        )
        .expect("plan");
        let helper = helper_command(&plan, 77, Path::new(r"C:\updates\install.log"));
        assert_eq!(
            helper.program,
            PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        assert_eq!(
            helper.args,
            args(&[
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                WINDOWS_HELPER,
            ])
        );
        assert_eq!(helper.env_value(ENV_PID), Some("77".as_ref()));
        assert_eq!(
            helper.env_value(ENV_INSTALLER),
            Some(r"C:\Users\me\AppData\Roaming\sh.pragma\updates\Pragma-0.6.0.exe".as_ref())
        );
        assert_eq!(
            helper.env_value(ENV_APP),
            Some(r"C:\Users\me\AppData\Local\Pragma\pragma.exe".as_ref())
        );
        // The silent flag is what keeps NSIS from prompting; the hooks honour it.
        assert!(WINDOWS_HELPER.contains("-ArgumentList '/S'"));
        assert!(WINDOWS_HELPER.contains("WaitForExit"));

        let err = plan_install(
            Path::new(r"C:\updates\Pragma-0.6.0.exe"),
            Path::new(r"C:\Pragma\pragma.exe"),
            &FakeHost::with(&[]),
        )
        .expect_err("no powershell");
        assert!(matches!(
            err,
            InstallFallback::MissingProgram("powershell.exe")
        ));
    }

    #[test]
    fn windows_msi_is_never_installed_in_place() {
        let err = plan_install(
            Path::new(r"C:\updates\Pragma-0.6.0.msi"),
            Path::new(r"C:\Program Files\Pragma\pragma.exe"),
            &FakeHost::with(&[("powershell.exe", "powershell.exe")]),
        )
        .expect_err("msi");
        assert_eq!(
            err.to_string(),
            ".msi installers are not installed in place"
        );
    }

    #[test]
    fn linux_deb_installs_through_pkexec_and_apt() {
        let host = FakeHost::with(&[
            ("pkexec", "/usr/bin/pkexec"),
            ("apt-get", "/usr/bin/apt-get"),
        ]);
        let plan = plan_install(
            Path::new("/home/me/.local/share/sh.pragma/updates/Pragma-0.6.0.deb"),
            Path::new("/usr/bin/pragma"),
            &host,
        )
        .expect("plan");
        let InstallPlan::ElevatedPackage { install, tool, app } = &plan else {
            panic!("expected an elevated package install, got {plan:?}");
        };
        assert_eq!(*tool, PackageTool::AptGet);
        assert_eq!(app, Path::new("/usr/bin/pragma"));
        assert_eq!(install.program, PathBuf::from("/usr/bin/pkexec"));
        assert_eq!(
            install.args,
            args(&[
                "/usr/bin/apt-get",
                "install",
                "-y",
                "/home/me/.local/share/sh.pragma/updates/Pragma-0.6.0.deb",
            ])
        );
        let helper = helper_command(&plan, 9, Path::new("/tmp/install.log"));
        assert_eq!(helper.program, PathBuf::from("/bin/sh"));
        assert_eq!(
            helper.args,
            args(&["-c", UNIX_HELPER, "sh", "/usr/bin/pragma"])
        );
        // Nothing is swapped: the package manager already replaced the files.
        assert_eq!(helper.env_value(ENV_STAGED), None);
    }

    #[test]
    fn linux_rpm_prefers_dnf_then_rpm() {
        let package = Path::new("/data/Pragma-0.6.0.rpm");
        let exe = Path::new("/usr/bin/pragma");
        let with_dnf = FakeHost::with(&[
            ("pkexec", "/usr/bin/pkexec"),
            ("dnf", "/usr/bin/dnf"),
            ("rpm", "/usr/bin/rpm"),
        ]);
        let InstallPlan::ElevatedPackage { install, .. } =
            plan_install(package, exe, &with_dnf).expect("dnf plan")
        else {
            panic!("expected an elevated install");
        };
        assert_eq!(
            install.args,
            args(&["/usr/bin/dnf", "install", "-y", "/data/Pragma-0.6.0.rpm"])
        );

        let rpm_only = FakeHost::with(&[("pkexec", "/usr/bin/pkexec"), ("rpm", "/usr/bin/rpm")]);
        let InstallPlan::ElevatedPackage { install, tool, .. } =
            plan_install(package, exe, &rpm_only).expect("rpm plan")
        else {
            panic!("expected an elevated install");
        };
        assert_eq!(tool, PackageTool::Rpm);
        assert_eq!(
            install.args,
            args(&["/usr/bin/rpm", "-U", "/data/Pragma-0.6.0.rpm"])
        );
    }

    #[test]
    fn linux_falls_back_without_pkexec_or_a_package_tool() {
        let exe = Path::new("/usr/bin/pragma");
        let err = plan_install(
            Path::new("/data/Pragma.deb"),
            exe,
            &FakeHost::with(&[("apt-get", "/usr/bin/apt-get")]),
        )
        .expect_err("no pkexec");
        assert_eq!(err.to_string(), "pkexec is not installed");
        let err = plan_install(
            Path::new("/data/Pragma.deb"),
            exe,
            &FakeHost::with(&[("pkexec", "/usr/bin/pkexec")]),
        )
        .expect_err("no apt");
        assert_eq!(err.to_string(), "apt-get is not installed");
        let err = plan_install(
            Path::new("/data/Pragma.AppImage"),
            exe,
            &FakeHost::with(&[("pkexec", "/usr/bin/pkexec")]),
        )
        .expect_err("appimage");
        assert!(matches!(err, InstallFallback::UnsupportedInstaller(_)));
    }

    #[test]
    fn pkexec_refusal_is_a_cancellation() {
        assert!(elevated_outcome(Some(0), "apt-get", "exit status: 0").is_ok());
        assert!(matches!(
            elevated_outcome(Some(126), "apt-get", "exit status: 126"),
            Err(InstallFallback::Cancelled)
        ));
        assert!(matches!(
            elevated_outcome(Some(127), "apt-get", "exit status: 127"),
            Err(InstallFallback::Cancelled)
        ));
        let err = elevated_outcome(Some(100), "apt-get", "exit status: 100").expect_err("fail");
        assert_eq!(
            err.to_string(),
            "installing the package failed: apt-get exited with exit status: 100"
        );
    }

    #[test]
    fn picks_the_app_out_of_a_mounted_image() {
        let entries = |names: &[&str]| names.iter().map(ToString::to_string).collect::<Vec<_>>();
        let image = entries(&["Applications", "Pragma.app", ".background"]);
        assert_eq!(pick_app_in_image(&image, "Pragma.app"), Some("Pragma.app"));
        // A renamed install still takes the only bundle in the image.
        assert_eq!(
            pick_app_in_image(&image, "Pragma 2.app"),
            Some("Pragma.app")
        );
        let ambiguous = entries(&["A.app", "B.app"]);
        assert_eq!(pick_app_in_image(&ambiguous, "Pragma.app"), None);
        assert_eq!(
            pick_app_in_image(&entries(&["Applications"]), "Pragma.app"),
            None
        );
    }

    /// Runs the POSIX helper to completion against an already-reaped pid.
    #[cfg(unix)]
    fn run_unix_helper(plan: &InstallPlan, dir: &Path) -> String {
        let mut child = crate::process::command("/bin/sh")
            .args(["-c", "sleep 0.3"])
            .spawn()
            .expect("spawn stand-in app");
        let pid = child.id();
        // Reap it the moment it exits: a zombie still answers `kill -0`.
        let reaper = std::thread::spawn(move || child.wait());
        let log = dir.join("install.log");
        let mut helper = helper_command(plan, pid, &log);
        // Relaunch with a no-op instead of `open`.
        helper.args.truncate(3);
        helper.args.extend(args(&["/bin/sh", "-c", ":"]));
        let status = helper.to_command().status().expect("run helper");
        assert!(status.success(), "helper failed: {status}");
        reaper.join().expect("reaper").expect("wait");
        std::fs::read_to_string(log).unwrap_or_default()
    }

    #[cfg(unix)]
    fn bundle_with_marker(path: &Path, marker: &str) {
        std::fs::create_dir_all(path.join("Contents")).expect("bundle");
        std::fs::write(path.join("Contents").join("marker"), marker).expect("marker");
    }

    #[cfg(unix)]
    #[test]
    fn unix_helper_swaps_the_staged_bundle_after_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bundle = dir.path().join("Pragma.app");
        let swap = BundleSwap::for_bundle(&dir.path().join("x.dmg"), &bundle).expect("swap");
        bundle_with_marker(&swap.bundle, "old");
        bundle_with_marker(&swap.staged, "new");
        let log = run_unix_helper(&InstallPlan::SwapBundle(swap.clone()), dir.path());
        let marker = std::fs::read_to_string(bundle.join("Contents/marker")).expect("marker");
        assert_eq!(marker, "new");
        assert!(!swap.staged.exists() && !swap.backup.exists());
        assert!(log.contains("installed the new app"), "{log}");
        assert!(log.contains("relaunching"), "{log}");
    }

    #[cfg(unix)]
    #[test]
    fn unix_helper_restores_the_old_bundle_when_the_swap_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bundle = dir.path().join("Pragma.app");
        let swap = BundleSwap::for_bundle(&dir.path().join("x.dmg"), &bundle).expect("swap");
        bundle_with_marker(&swap.bundle, "old");
        // No staged copy: the second rename fails and the first must be undone.
        let log = run_unix_helper(&InstallPlan::SwapBundle(swap), dir.path());
        let marker = std::fs::read_to_string(bundle.join("Contents/marker")).expect("marker");
        assert_eq!(marker, "old");
        assert!(log.contains("restoring the old one"), "{log}");
        assert!(log.contains("relaunching"), "{log}");
    }
}
