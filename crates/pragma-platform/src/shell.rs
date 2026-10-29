//! Resolving shells for interactive PTYs and non-interactive commands.
//!
//! macOS and Linux have a convention for this — the `SHELL` environment
//! variable, with a well-known fallback. Windows has none, so the shell is
//! found by probing a candidate list against `PATH`: PowerShell 7 (`pwsh.exe`)
//! when it is installed, and the in-box Windows PowerShell otherwise.
//!
//! Every default here comes from `@pragma-sh/constants`, because the Settings UI
//! shows the same list the session layer launches from.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use pragma_constants::{ShellProfile, TerminalBackend, CONSTANTS};

use crate::wsl;

/// Parses a shell profile from a `.pragma/config.json` `terminal` block.
///
/// An unrecognised backend returns `None` so the caller can report the typo
/// rather than silently launching the wrong kind of terminal. `powershell` is
/// accepted as a spelling of `native` because that is what the Windows default
/// actually launches, and users reach for it.
#[must_use]
pub fn parse_profile(backend: &str, distro: Option<&str>) -> Option<ShellProfile> {
    match backend.trim().to_ascii_lowercase().as_str() {
        "native" | "powershell" => Some(native_profile()),
        "wsl" => Some(ShellProfile {
            backend: TerminalBackend::Wsl,
            distro: distro
                .map(str::trim)
                .filter(|it| !it.is_empty())
                .map(str::to_string),
        }),
        _ => None,
    }
}

/// The host's own shell, on the host's own PTY.
#[must_use]
pub fn native_profile() -> ShellProfile {
    ShellProfile {
        backend: TerminalBackend::Native,
        distro: None,
    }
}

/// The profile used when neither the tab nor the project names one.
///
/// WSL is never a default: it depends on a distribution being installed, so it
/// is opt-in through the shipped `platform.defaultBackend`.
#[must_use]
pub fn default_profile() -> ShellProfile {
    match CONSTANTS.platform.default_backend {
        TerminalBackend::Native => native_profile(),
        TerminalBackend::Wsl => ShellProfile {
            backend: TerminalBackend::Wsl,
            distro: None,
        },
    }
}

/// A shell to launch, with the arguments that make it an interactive session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellLaunch {
    /// Program to execute.
    pub program: String,
    /// Arguments that put the shell into the right interactive mode.
    pub args: Vec<String>,
}

/// Resolves the shell for a native session.
///
/// `configured` is the project's `.pragma/config.json` override and wins over
/// everything when it is set.
#[must_use]
pub fn resolve_shell(configured: Option<&str>) -> String {
    if let Some(shell) = configured.map(str::trim).filter(|it| !it.is_empty()) {
        return shell.to_string();
    }
    default_shell()
}

/// Resolves the shell to launch together with its interactive arguments.
#[must_use]
pub fn resolve_launch(configured: Option<&str>) -> ShellLaunch {
    let program = resolve_shell(configured);
    let args = interactive_args(&program);
    ShellLaunch { program, args }
}

/// Resolves the launch for one shell profile.
///
/// `configured` is the project's native shell override; it is ignored for a WSL
/// profile, whose shell is whatever login shell the distribution itself is set
/// up with.
///
/// The WSL launch passes no working directory of its own: `wsl.exe` translates
/// the Windows working directory it inherits into its `/mnt/...` equivalent, so
/// the session opens in the worktree the caller already set as the child's cwd.
#[must_use]
pub fn resolve_profile_launch(profile: &ShellProfile, configured: Option<&str>) -> ShellLaunch {
    profile_launch(profile, configured, wsl::is_windows())
}

/// The launch rule, with the host's WSL capability injected so both branches
/// are testable on every platform.
///
/// A WSL profile can reach a macOS or Linux host by more than one route: a
/// `.pragma/config.json` is checked in and shared across machines, a spawn
/// request names its own backend, and `platform.defaultBackend` is a shipped
/// constant. `wsl.exe` exists on none of them, so constructing that command
/// anyway fails the spawn with an opaque "program not found" — the terminal
/// simply never opens. Falling back to the host's own shell honours the part of
/// the request the host can actually satisfy: a working terminal in the
/// worktree.
fn profile_launch(
    profile: &ShellProfile,
    configured: Option<&str>,
    wsl_available: bool,
) -> ShellLaunch {
    match profile.backend {
        TerminalBackend::Native => resolve_launch(configured),
        TerminalBackend::Wsl if !wsl_available => resolve_launch(configured),
        TerminalBackend::Wsl => ShellLaunch {
            program: CONSTANTS.platform.wsl.launcher.clone(),
            args: profile
                .distro
                .as_deref()
                .map(str::trim)
                .filter(|distro| !distro.is_empty())
                .map_or_else(Vec::new, |distro| {
                    vec!["-d".to_string(), distro.to_string()]
                }),
        },
    }
}

/// The arguments that make `program` behave as an interactive login shell.
///
/// POSIX shells take `-l`. PowerShell does not: `-l` there abbreviates
/// `-Login`, which is only meaningful on macOS and Linux and is an error on
/// Windows — so passing it would fail every terminal Pragma opens. PowerShell
/// gets `-NoLogo` instead, which suppresses the startup banner that would
/// otherwise print into a fresh tab on every launch.
#[must_use]
pub fn interactive_args(program: &str) -> Vec<String> {
    if is_powershell(program) {
        vec!["-NoLogo".to_string()]
    } else if is_cmd(program) {
        Vec::new()
    } else {
        vec!["-l".to_string()]
    }
}

/// Builds arguments that ask `program` to run one command and exit.
#[must_use]
pub fn command_args(program: &str, command: &str) -> Vec<String> {
    if is_powershell(program) {
        vec!["-Command".to_string(), command.to_string()]
    } else if is_cmd(program) {
        vec!["/C".to_string(), command.to_string()]
    } else {
        vec!["-c".to_string(), command.to_string()]
    }
}

/// Renders one command as a line an interactive `program` will run when it is
/// typed into that shell.
///
/// This is not the same problem as [`command_args`]: an agent launch is *typed*
/// into a shell that is already running, so the parts have to be quoted the way
/// that shell parses them. POSIX single quotes are not PowerShell quoting — a
/// path with a space would split, and an embedded quote would end the string —
/// so the two are built separately rather than sharing one escape.
///
/// PowerShell also needs the call operator in front of a *quoted* executable:
/// `'C:\Program Files\…\pragma-cli.exe' agent run` parses the first word as a
/// string expression, not a command, and fails before the agent starts. `&`
/// puts the quoted path in executable position. A bare command name already is
/// in executable position, so the common line stays unadorned.
#[must_use]
pub fn interactive_command_line(program: &str, parts: &[String]) -> String {
    let quoted = parts
        .iter()
        .map(|part| quote_for_shell(program, part))
        .collect::<Vec<_>>();
    let Some(first) = quoted.first() else {
        return String::new();
    };
    let line = quoted.join(" ");
    // A quoted first word is a PowerShell string expression, never a command.
    // POSIX and `cmd.exe` execute a quoted command name directly, so this is
    // deliberately PowerShell-only.
    if is_powershell(program) && first != &parts[0] {
        format!("& {line}")
    } else {
        line
    }
}

/// Quotes one value the way `program`'s shell parses it, for splicing into a
/// command string that shell will run (e.g. as an argument to a generated
/// `cd`). See [`interactive_command_line`] for why POSIX and PowerShell/`cmd`
/// quoting are not interchangeable.
#[must_use]
pub fn quote_for_shell(program: &str, value: &str) -> String {
    if is_powershell(program) {
        quote_powershell(value)
    } else if is_cmd(program) {
        quote_cmd(value)
    } else {
        quote_posix(value)
    }
}

/// POSIX single-quoting: everything is literal inside `'…'`, and an embedded
/// quote is spelled `'\''`.
fn quote_posix(value: &str) -> String {
    if !value.is_empty() && value.bytes().all(is_bare_posix_byte) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// PowerShell single-quoting: everything is literal inside `'…'`, and an
/// embedded quote is doubled (`''`). No backslash escapes — a Windows path is
/// safe verbatim, which a POSIX escape would have mangled.
fn quote_powershell(value: &str) -> String {
    if !value.is_empty() && value.bytes().all(is_bare_powershell_byte) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "''"))
}

/// `cmd.exe` has no escape inside quotes at all; a literal double quote cannot
/// be expressed, so it is dropped rather than allowed to break the line apart.
fn quote_cmd(value: &str) -> String {
    if !value.is_empty() && value.bytes().all(is_bare_powershell_byte) {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', ""))
}

fn is_bare_posix_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"_./:=@+-".contains(&byte)
}

/// Backslash is bare on Windows because it is the path separator; `'` is not,
/// so a value containing one always takes the quoted branch.
fn is_bare_powershell_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"_./:=@+-\\".contains(&byte)
}

/// Whether a program path names PowerShell, in either edition.
fn is_powershell(program: &str) -> bool {
    matches!(
        stem(program).as_str(),
        "pwsh" | "powershell" | "pwsh-preview"
    )
}

/// Whether a program path names the legacy Windows command interpreter.
fn is_cmd(program: &str) -> bool {
    stem(program) == "cmd"
}

/// Lowercased file stem of a program path, so `C:\...\pwsh.exe` reads as `pwsh`.
///
/// Both separators are handled explicitly rather than deferring to
/// `Path::file_stem`, which only recognises the *host's* separator: a Windows
/// path examined on Unix would come back whole, and the shell would then be
/// launched with POSIX arguments it cannot parse.
fn stem(program: &str) -> String {
    let file_name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let stem = file_name
        .rsplit_once('.')
        .map_or(file_name, |(stem, _extension)| stem);
    stem.to_ascii_lowercase()
}

/// The shell to launch when nothing is configured.
#[must_use]
pub fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL")
            .ok()
            .map(|shell| shell.trim().to_string())
            .filter(|shell| !shell.is_empty())
            .unwrap_or_else(|| unix_fallback_shell().to_string())
    }
    #[cfg(windows)]
    {
        // `SHELL` is not a Windows convention, but Git Bash and some CI images
        // set it. Honour it when present so those environments behave, then
        // fall back to probing PowerShell.
        std::env::var("SHELL")
            .ok()
            .map(|shell| shell.trim().to_string())
            .filter(|shell| !shell.is_empty())
            .unwrap_or_else(|| {
                let candidates: Vec<&str> = CONSTANTS
                    .platform
                    .shells
                    .windows
                    .iter()
                    .map(String::as_str)
                    .collect();
                pick_windows_shell(&candidates, |name| find_on_path(name).is_some())
            })
    }
}

/// The documented fallback for the current Unix flavour.
#[cfg(unix)]
#[must_use]
fn unix_fallback_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        &CONSTANTS.platform.shells.macos
    } else {
        &CONSTANTS.platform.shells.linux
    }
}

/// Chooses the first installed Windows shell candidate.
///
/// Falls back to the last candidate when none is found: that entry is the
/// in-box Windows PowerShell, which is present on every Windows install, so
/// launching it is a better failure than launching nothing. Kept generic over
/// the lookup so the ordering rule is testable off Windows.
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_windows_shell(candidates: &[&str], installed: impl Fn(&str) -> bool) -> String {
    candidates
        .iter()
        .find(|candidate| installed(candidate))
        .or_else(|| candidates.last())
        .map_or_else(String::new, |candidate| (*candidate).to_string())
}

/// Finds an executable by walking `PATH`.
///
/// Windows bare names are also checked against `PATHEXT`.
#[must_use]
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| find_on_path_in(name, &path))
}

/// Finds an executable by walking an explicit platform-native PATH list.
#[must_use]
pub fn find_on_path_in(name: &str, path: &OsStr) -> Option<PathBuf> {
    if Path::new(name).is_absolute() {
        return is_executable(Path::new(name)).then(|| PathBuf::from(name));
    }
    std::env::split_paths(path).find_map(|dir| find_in_path_dir(&dir, name))
}

fn find_in_path_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    // npm, bun, and every node CLI ship an extensionless POSIX script *next to*
    // the shim Windows can actually start. Returning that script first hands
    // `CreateProcess` (or `cmd.exe`) something it cannot execute, which is how
    // `npm` looked "not found" on Windows. Try PATHEXT matches first there.
    if cfg!(windows) && Path::new(name).extension().is_none() {
        if let Some(found) = path_extensions().split(';').find_map(|extension| {
            let candidate = dir.join(format!("{name}{extension}"));
            is_executable(&candidate).then_some(candidate)
        }) {
            // PATHEXT spelling is uppercase; return the file's own casing so callers
            // that compare or display the path see what is really on disk.
            return Some(crate::path::canonicalize(&found).unwrap_or(found));
        }
    }
    let candidate = dir.join(name);
    is_executable(&candidate).then_some(candidate)
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolves a program on the provided PATH, including the platform shell fallback.
#[must_use]
pub fn resolve_program(name: &str, path: &OsStr) -> Option<PathBuf> {
    find_on_path_in(name, path).or_else(|| {
        if cfg!(windows) && name == "sh" {
            find_git_bash()
        } else {
            None
        }
    })
}

/// Platform-specific user tool directories, honoring redirected Windows folders.
#[must_use]
pub fn user_tool_paths(home: Option<&Path>) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    windows_tool_paths(
        home,
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("LOCALAPPDATA").as_deref(),
    )
}

fn windows_tool_paths(
    home: Option<&Path>,
    appdata: Option<&OsStr>,
    localappdata: Option<&OsStr>,
) -> Vec<PathBuf> {
    let folder = |value: Option<&OsStr>, fallback: &str| {
        value
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join("AppData").join(fallback)))
    };
    let mut paths = Vec::new();
    if let Some(path) = folder(appdata, "Roaming") {
        paths.push(path.join("npm"));
    }
    if let Some(path) = folder(localappdata, "Local") {
        paths.push(path.join("Microsoft").join("WindowsApps"));
    }
    if let Some(home) = home {
        paths.push(home.join("scoop").join("shims"));
    }
    paths
}

fn path_extensions() -> String {
    std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
}

/// The POSIX shell Git for Windows ships, if this machine has one.
///
/// Pragma's official plugin installers are `sh scripts/install.sh`, and Windows
/// has no `sh` on `PATH` by default. Git for Windows is already a prerequisite
/// (the host runs `git` constantly), and it carries `bin\bash.exe`, so derive the
/// shell from the resolved `git.exe` instead of guessing at `PATH` — a bare `sh`
/// can also be the WSL launcher, which sees a different filesystem and `PATH`.
///
/// Always `None` off Windows: those hosts have a real `/bin/sh`.
#[must_use]
pub fn find_git_bash() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    if let Some(git) = find_on_path("git") {
        if let Some(bash) = bash_near_git(&git) {
            return Some(bash);
        }
    }
    ["C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git"]
        .into_iter()
        .map(|root| Path::new(root).join("bin").join("bash.exe"))
        .find(|candidate| candidate.is_file())
}

/// The shell beside a Git for Windows installation, whatever layout it uses.
fn bash_near_git(git: &Path) -> Option<PathBuf> {
    let dir = git.parent()?;
    [
        Path::new("bash.exe"),           // <git>/bin/git.exe
        Path::new("../bin/bash.exe"),    // <git>/cmd/git.exe
        Path::new("../../bin/bash.exe"), // <git>/mingw64/bin/git.exe
        Path::new("../bin/sh.exe"),
        Path::new("../../bin/sh.exe"),
    ]
    .into_iter()
    .map(|relative| dir.join(relative))
    .filter(|candidate| candidate.is_file())
    .find_map(|candidate| crate::path::canonicalize(candidate).ok())
}

#[cfg(test)]
mod tests {
    use pragma_constants::TerminalBackend;
    use std::ffi::OsStr;
    use std::path::Path;

    use super::{
        bash_near_git, find_on_path, find_on_path_in, interactive_command_line, parse_profile,
        pick_windows_shell, profile_launch, resolve_profile_launch, resolve_shell, ShellLaunch,
        ShellProfile,
    };

    fn wsl(distro: Option<&str>) -> ShellProfile {
        ShellProfile {
            backend: TerminalBackend::Wsl,
            distro: distro.map(str::to_string),
        }
    }

    /// The launch a Windows host resolves, asserted from any platform.
    fn on_windows(profile: &ShellProfile, configured: Option<&str>) -> ShellLaunch {
        profile_launch(profile, configured, true)
    }

    #[test]
    fn a_configured_shell_wins_over_every_default() {
        assert_eq!(
            resolve_shell(Some("/usr/bin/fish")),
            "/usr/bin/fish".to_string()
        );
    }

    #[test]
    fn a_blank_configured_shell_falls_back_to_the_default() {
        assert_eq!(resolve_shell(Some("   ")), super::default_shell());
    }

    #[test]
    fn powershell_seven_is_preferred_when_it_is_installed() {
        let chosen = pick_windows_shell(&["pwsh.exe", "powershell.exe"], |name| {
            name == "pwsh.exe" || name == "powershell.exe"
        });
        assert_eq!(chosen, "pwsh.exe");
    }

    #[test]
    fn windows_powershell_is_used_when_pwsh_is_absent() {
        let chosen = pick_windows_shell(&["pwsh.exe", "powershell.exe"], |name| {
            name == "powershell.exe"
        });
        assert_eq!(chosen, "powershell.exe");
    }

    /// Resolving to an empty string would hand `CommandBuilder` a blank program
    /// and fail the spawn with no useful message. The in-box shell is always
    /// present, so it is the right thing to try.
    #[test]
    fn an_unresolvable_probe_still_yields_the_in_box_shell() {
        let chosen = pick_windows_shell(&["pwsh.exe", "powershell.exe"], |_| false);
        assert_eq!(chosen, "powershell.exe");
    }

    #[test]
    fn the_shipped_windows_candidates_end_with_an_always_present_shell() {
        let candidates = &pragma_constants::CONSTANTS.platform.shells.windows;
        assert_eq!(
            candidates.last().map(String::as_str),
            Some("powershell.exe"),
            "the last candidate is the no-probe fallback and must exist on every Windows install"
        );
    }

    #[test]
    fn backends_parse_from_config_values() {
        assert_eq!(parse_profile("native", None), Some(super::native_profile()));
        assert_eq!(
            parse_profile("WSL", Some("Ubuntu")),
            Some(wsl(Some("Ubuntu")))
        );
        assert_eq!(parse_profile("wsl", None), Some(wsl(None)));
    }

    /// A blank distribution is the same statement as an absent one — "use
    /// whichever WSL calls default" — and must not reach `wsl.exe -d ""`.
    #[test]
    fn a_blank_distro_means_the_wsl_default() {
        assert_eq!(parse_profile("wsl", Some("   ")), Some(wsl(None)));
        assert_eq!(
            on_windows(&wsl(Some("  ")), None).args,
            [] as [std::string::String; 0]
        );
    }

    /// A typo must surface, not silently launch a native shell where the user
    /// asked for a Linux one.
    #[test]
    fn an_unknown_backend_is_rejected() {
        assert_eq!(parse_profile("wsl2", None), None);
        assert_eq!(parse_profile("", None), None);
    }

    /// The distribution has to reach `wsl.exe` as `-d <name>`; without it every
    /// WSL tab silently opens the default distribution instead of the picked one.
    #[test]
    fn a_wsl_profile_launches_the_named_distribution() {
        let launch = on_windows(&wsl(Some("Ubuntu")), None);
        assert_eq!(
            launch.program,
            pragma_constants::CONSTANTS.platform.wsl.launcher
        );
        assert_eq!(launch.args, vec!["-d".to_string(), "Ubuntu".to_string()]);
    }

    /// The native shell override is a Windows/Unix program path; applying it to
    /// a WSL launch would try to run e.g. `pwsh.exe` inside the distribution.
    #[test]
    fn a_native_shell_override_does_not_leak_into_a_wsl_launch() {
        let launch = on_windows(&wsl(None), Some("/usr/bin/fish"));
        assert_eq!(
            launch.program,
            pragma_constants::CONSTANTS.platform.wsl.launcher
        );
        assert_eq!(launch.args, [] as [std::string::String; 0]);
    }

    /// `wsl.exe` does not exist on macOS or Linux, and a WSL profile reaches
    /// those hosts through a shared `config.json`, a client spawn request, or
    /// the shipped `platform.defaultBackend`. Building the command anyway fails
    /// the spawn outright, so the host's own shell is the launch instead.
    #[test]
    fn a_wsl_profile_falls_back_to_the_host_shell_where_wsl_cannot_exist() {
        for profile in [wsl(None), wsl(Some("Ubuntu"))] {
            let launch = profile_launch(&profile, None, false);
            assert_ne!(
                launch.program,
                pragma_constants::CONSTANTS.platform.wsl.launcher
            );
            assert_eq!(launch, super::resolve_launch(None));
        }
    }

    /// Falling back means launching a native shell, so the native override is
    /// the right shell to launch — it is no longer a foreign program path.
    #[test]
    fn the_non_windows_fallback_honours_the_configured_native_shell() {
        let launch = profile_launch(&wsl(Some("Ubuntu")), Some("/usr/bin/fish"), false);
        assert_eq!(launch.program, "/usr/bin/fish");
    }

    /// The public entry point has to agree with the host it is compiled for,
    /// or the fallback is unreachable where it matters.
    #[test]
    fn the_public_launch_follows_the_hosts_capability() {
        let launch = resolve_profile_launch(&wsl(Some("Ubuntu")), None);
        if cfg!(windows) {
            assert_eq!(
                launch.program,
                pragma_constants::CONSTANTS.platform.wsl.launcher
            );
        } else {
            assert_eq!(launch, super::resolve_launch(None));
        }
    }

    #[test]
    fn a_native_profile_still_honours_the_configured_shell() {
        let launch = resolve_profile_launch(&super::native_profile(), Some("/usr/bin/fish"));
        assert_eq!(launch.program, "/usr/bin/fish");
    }

    /// `-l` is the failure this guards: PowerShell reads it as `-Login`, which
    /// is an error on Windows, so every terminal would fail to open.
    #[test]
    fn powershell_is_not_given_the_posix_login_flag() {
        for program in [
            "pwsh.exe",
            "powershell.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            "PWSH.EXE",
        ] {
            let args = super::interactive_args(program);
            assert!(
                !args.iter().any(|arg| arg == "-l"),
                "{program} must not receive -l, got {args:?}"
            );
            assert_eq!(args, vec!["-NoLogo".to_string()]);
        }
    }

    /// PowerShell installed without an `.exe` (as it is on macOS and Linux)
    /// must still be recognised, so it is not handed POSIX arguments.
    #[test]
    fn powershell_is_recognised_without_an_extension() {
        assert_eq!(super::stem("/usr/local/bin/pwsh"), "pwsh");
        assert_eq!(
            super::interactive_args("/usr/local/bin/pwsh"),
            vec!["-NoLogo"]
        );
    }

    #[test]
    fn a_program_path_reduces_to_its_bare_name() {
        assert_eq!(super::stem("/bin/zsh"), "zsh");
        assert_eq!(super::stem(r"C:\Windows\System32\cmd.exe"), "cmd");
        assert_eq!(super::stem("sh"), "sh");
    }

    #[test]
    fn posix_shells_are_launched_as_login_shells() {
        for program in ["/bin/zsh", "/bin/sh", "/usr/bin/fish"] {
            assert_eq!(super::interactive_args(program), vec!["-l".to_string()]);
        }
    }

    /// `cmd.exe` rejects both `-l` and `-NoLogo`.
    #[test]
    fn the_legacy_command_interpreter_takes_no_arguments() {
        assert_eq!(
            super::interactive_args("cmd.exe"),
            [] as [std::string::String; 0]
        );
    }

    #[test]
    fn command_arguments_follow_each_shell_family() {
        assert_eq!(
            super::command_args("pwsh.exe", "Write-Output hi"),
            vec!["-Command", "Write-Output hi"]
        );
        assert_eq!(
            super::command_args("cmd.exe", "echo hi"),
            vec!["/C", "echo hi"]
        );
        assert_eq!(
            super::command_args("/bin/sh", "printf hi"),
            vec!["-c", "printf hi"]
        );
    }

    #[test]
    fn a_configured_shell_carries_its_own_interactive_arguments() {
        let launch = super::resolve_launch(Some("pwsh.exe"));
        assert_eq!(launch.program, "pwsh.exe");
        assert_eq!(launch.args, vec!["-NoLogo".to_string()]);
    }

    #[test]
    fn an_absolute_path_resolves_to_itself_when_it_exists() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("tool");
        std::fs::write(&file, b"").expect("seed an executable");
        crate::perms::set_executable(&file).expect("executable");
        assert_eq!(
            find_on_path(file.to_str().expect("utf-8 path")),
            Some(file.clone())
        );
    }

    #[test]
    fn a_missing_absolute_path_resolves_to_nothing() {
        assert_eq!(find_on_path("/definitely/not/here/pwsh.exe"), None);
    }

    /// npm and node CLIs ship both an extensionless POSIX script and a Windows
    /// shim in the same directory. The shim is the only one the OS can start.
    #[test]
    fn a_windows_shim_wins_over_an_extensionless_script() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("tool"), b"#!/bin/sh\n").expect("posix script");
        crate::perms::set_executable(&dir.path().join("tool")).expect("executable");
        std::fs::write(dir.path().join("tool.cmd"), b"@echo off\r\n").expect("cmd shim");
        let found = find_on_path_in("tool", dir.path().as_os_str()).expect("resolved");
        if cfg!(windows) {
            assert_eq!(
                found,
                crate::path::canonicalize(dir.path().join("tool.cmd")).expect("canonical shim")
            );
        } else {
            assert_eq!(found, dir.path().join("tool"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn lookup_skips_non_executable_files() {
        let first = tempfile::tempdir().expect("first directory");
        let second = tempfile::tempdir().expect("second directory");
        std::fs::write(first.path().join("tool"), b"").expect("file");
        let executable = second.path().join("tool");
        std::fs::write(&executable, b"").expect("file");
        crate::perms::set_executable(&executable).expect("executable");
        let path = std::env::join_paths([first.path(), second.path()]).expect("path");
        assert_eq!(find_on_path_in("tool", &path), Some(executable));
    }

    #[test]
    fn windows_tool_paths_use_redirected_folders_and_fallbacks() {
        let home = Path::new("home");
        let paths = super::windows_tool_paths(
            Some(home),
            Some(OsStr::new("roaming")),
            Some(OsStr::new("local")),
        );
        assert_eq!(
            paths,
            vec![
                Path::new("roaming").join("npm"),
                Path::new("local").join("Microsoft/WindowsApps"),
                home.join("scoop/shims")
            ]
        );
        let paths = super::windows_tool_paths(Some(home), None, None);
        assert_eq!(paths[0], home.join("AppData/Roaming/npm"));
        assert_eq!(paths[1], home.join("AppData/Local/Microsoft/WindowsApps"));
    }

    /// Git for Windows ships its POSIX shell beside `git.exe`; both the
    /// `<git>/cmd` and `<git>/mingw64/bin` layouts must resolve.
    #[test]
    fn git_bash_is_found_beside_either_git_layout() {
        let dir = tempfile::tempdir().expect("temp dir");
        for layout in ["cmd", "mingw64/bin"] {
            let git_dir = dir.path().join(layout);
            std::fs::create_dir_all(&git_dir).expect("git dir");
            std::fs::write(git_dir.join("git.exe"), b"").expect("git");
            std::fs::create_dir_all(dir.path().join("bin")).expect("bin");
            std::fs::write(dir.path().join("bin/bash.exe"), b"").expect("bash");
            assert_eq!(
                bash_near_git(&git_dir.join("git.exe")),
                crate::path::canonicalize(dir.path().join("bin/bash.exe")).ok(),
                "layout {layout}"
            );
        }
    }

    #[test]
    fn interactive_command_lines_are_quoted_for_the_shell_that_will_parse_them() {
        let parts = vec![
            "C:\\Program Files\\opencode\\opencode.exe".to_string(),
            "--model".to_string(),
            "it's".to_string(),
        ];
        // PowerShell: call operator for the quoted executable, doubled quote
        // for an embedded quote, and no backslash escaping.
        let pwsh = interactive_command_line("pwsh.exe", &parts);
        assert_eq!(
            pwsh,
            "& 'C:\\Program Files\\opencode\\opencode.exe' --model 'it''s'"
        );
        assert!(
            !pwsh.contains("\\'"),
            "PowerShell has no backslash escape: {pwsh}"
        );

        // POSIX: `'\''` for an embedded quote, and no call operator.
        let posix = interactive_command_line("/bin/zsh", &["it's".to_string()]);
        assert_eq!(posix, "'it'\\''s'");

        // Bare words stay bare in both.
        assert_eq!(
            interactive_command_line("/bin/zsh", &["opencode".to_string()]),
            "opencode"
        );
        assert_eq!(
            interactive_command_line("pwsh", &["opencode".to_string()]),
            "opencode"
        );
    }

    /// A quoted word in PowerShell command position is a string expression:
    /// `'C:\Program Files\…\pragma-cli.exe' agent run` fails to parse, so the
    /// tracked launch never starts. The call operator makes it executable.
    #[test]
    fn a_quoted_powershell_executable_is_invoked_with_the_call_operator() {
        let spaced = vec![
            "C:\\Users\\Jane Doe\\AppData\\Local\\Pragma\\pragma-cli.exe".to_string(),
            "agent".to_string(),
            "run".to_string(),
            "--run-id".to_string(),
            "run-1".to_string(),
        ];
        assert_eq!(
            interactive_command_line("pwsh.exe", &spaced),
            "& 'C:\\Users\\Jane Doe\\AppData\\Local\\Pragma\\pragma-cli.exe' agent run --run-id run-1"
        );

        let apostrophe = vec![
            "C:\\Users\\Jane O'Doe\\pragma-cli.exe".to_string(),
            "agent".to_string(),
            "run".to_string(),
        ];
        assert_eq!(
            interactive_command_line("powershell.exe", &apostrophe),
            "& 'C:\\Users\\Jane O''Doe\\pragma-cli.exe' agent run"
        );
    }

    /// A bare executable is already in command position, so it needs no call
    /// operator — including an absolute path with no characters that force
    /// quoting.
    #[test]
    fn a_bare_powershell_executable_needs_no_call_operator() {
        let bare = vec![
            "opencode".to_string(),
            "--model".to_string(),
            "sonnet".to_string(),
        ];
        assert_eq!(
            interactive_command_line("pwsh", &bare),
            "opencode --model sonnet"
        );

        let unspaced_path = vec![
            "C:\\Users\\Jane\\bin\\pragma-cli.exe".to_string(),
            "agent".to_string(),
        ];
        assert_eq!(
            interactive_command_line("pwsh.exe", &unspaced_path),
            "C:\\Users\\Jane\\bin\\pragma-cli.exe agent"
        );
    }

    /// The call operator is PowerShell syntax; `cmd.exe` treats `&` as a
    /// command separator, and POSIX executes a quoted command name directly.
    #[test]
    fn other_shells_do_not_gain_a_call_operator() {
        let posix = vec![
            "/Users/Jane Doe/bin/pragma-cli".to_string(),
            "agent".to_string(),
        ];
        assert_eq!(
            interactive_command_line("/bin/zsh", &posix),
            "'/Users/Jane Doe/bin/pragma-cli' agent"
        );

        let cmd = vec![
            "C:\\Program Files\\Pragma\\pragma-cli.exe".to_string(),
            "agent".to_string(),
        ];
        assert_eq!(
            interactive_command_line("cmd.exe", &cmd),
            "\"C:\\Program Files\\Pragma\\pragma-cli.exe\" agent"
        );
    }

    #[test]
    fn an_empty_command_line_stays_empty() {
        assert_eq!(interactive_command_line("pwsh.exe", &[] as &[String]), "");
    }
}
