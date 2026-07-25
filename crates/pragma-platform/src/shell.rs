//! Resolving the interactive shell a PTY should launch.
//!
//! macOS and Linux have a convention for this — the `SHELL` environment
//! variable, with a well-known fallback. Windows has none, so the shell is
//! found by probing a candidate list against `PATH`: PowerShell 7 (`pwsh.exe`)
//! when it is installed, and the in-box Windows PowerShell otherwise.
//!
//! Every default here comes from `@pragma/constants`, because the Settings UI
//! shows the same list the session layer launches from.

use std::path::{Path, PathBuf};

use pragma_constants::CONSTANTS;

/// Which world a terminal session's shell runs in.
///
/// Only Windows offers a real choice. macOS and Linux always resolve to
/// [`TerminalBackend::Native`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum TerminalBackend {
    /// The host's own shell, on the host's own PTY.
    #[default]
    Native,
    /// A Linux shell inside a WSL distribution, served by a Linux
    /// `pragma-server` running in that distribution. `None` means the user's
    /// default distribution.
    Wsl { distro: Option<String> },
}

impl TerminalBackend {
    /// Parses a backend from a `.pragma/config.json` value.
    ///
    /// An unrecognised value returns `None` so the caller can report the typo
    /// rather than silently launching the wrong kind of terminal.
    #[must_use]
    pub fn parse(value: &str, distro: Option<&str>) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "native" | "powershell" => Some(Self::Native),
            "wsl" => Some(Self::Wsl {
                distro: distro
                    .map(str::to_string)
                    .filter(|it| !it.trim().is_empty()),
            }),
            _ => None,
        }
    }

    /// The backend used when a project configures none.
    ///
    /// WSL is never a default: it depends on a distribution being installed and
    /// on a Linux `pragma-server` running inside it, so it is opt-in.
    #[must_use]
    pub fn configured_default() -> Self {
        match CONSTANTS.platform.default_backend {
            pragma_constants::TerminalBackend::Native => Self::Native,
            pragma_constants::TerminalBackend::Wsl => Self::Wsl { distro: None },
        }
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
/// Windows resolves a bare name against `PATHEXT`, but every candidate Pragma
/// probes already carries its `.exe`, so a plain existence check is enough.
#[must_use]
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    if Path::new(name).is_absolute() {
        return Path::new(name).is_file().then(|| PathBuf::from(name));
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::{find_on_path, pick_windows_shell, resolve_shell, TerminalBackend};

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
        assert_eq!(
            TerminalBackend::parse("native", None),
            Some(TerminalBackend::Native)
        );
        assert_eq!(
            TerminalBackend::parse("WSL", Some("Ubuntu")),
            Some(TerminalBackend::Wsl {
                distro: Some("Ubuntu".to_string())
            })
        );
        assert_eq!(
            TerminalBackend::parse("wsl", None),
            Some(TerminalBackend::Wsl { distro: None })
        );
    }

    /// A typo must surface, not silently launch a native shell where the user
    /// asked for a Linux one.
    #[test]
    fn an_unknown_backend_is_rejected() {
        assert_eq!(TerminalBackend::parse("wsl2", None), None);
        assert_eq!(TerminalBackend::parse("", None), None);
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
        assert!(super::interactive_args("cmd.exe").is_empty());
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
        assert_eq!(
            find_on_path(file.to_str().expect("utf-8 path")),
            Some(file.clone())
        );
    }

    #[test]
    fn a_missing_absolute_path_resolves_to_nothing() {
        assert_eq!(find_on_path("/definitely/not/here/pwsh.exe"), None);
    }
}
