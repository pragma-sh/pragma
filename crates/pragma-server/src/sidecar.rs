//! Where the host's sidecars live, and how to run a one-shot one.
//!
//! Every supervisor here (`pragma-plugins`, `pragma-watch`, `pragma-github`,
//! the fanout host) resolves its executable the same way and, in a dev build,
//! runs the TypeScript entry point through `bun` instead. That resolution
//! belongs in one place: three copies of it drifted apart once already, and a
//! sidecar that resolves differently from its neighbours fails only in a
//! packaged build.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A sidecar's file name on this platform.
///
/// Never a bare string: on Windows the executable is `pragma-github.exe`, and a
/// suffix-less path is both unreadable and not something an agent resolving it
/// from `PATH` can execute.
pub fn executable_name(name: &str) -> String {
    let suffix = std::env::consts::EXE_SUFFIX;
    if suffix.is_empty() || name.ends_with(suffix) {
        name.to_string()
    } else {
        format!("{name}{suffix}")
    }
}

/// Absolute path of a packaged sidecar, beside this executable.
pub fn sidecar_executable(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// The repository root, for dev builds that run a sidecar from source.
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

/// Builds the command that runs a sidecar: its TypeScript entry point under
/// `bun` in a dev build, the compiled binary otherwise.
///
/// Always through `pragma_platform::process::command`, never a bare
/// `Command::new`: a console program started from a GUI process pops a console
/// window on Windows without `CREATE_NO_WINDOW`.
pub fn sidecar_command(name: &str, dev_entry: &str) -> Command {
    if cfg!(debug_assertions) {
        let mut command = pragma_platform::process::command("bun");
        command.arg(dev_entry).current_dir(workspace_root());
        command
    } else {
        pragma_platform::process::command(sidecar_executable(&executable_name(name)))
    }
}

/// Runs a one-shot sidecar command and returns the last JSON line it printed.
///
/// One-shot rather than supervised: these calls are user-initiated, infrequent,
/// and independent, so a process per call costs nothing and keeps a crash from
/// taking down anything else. `stdin_data` carries a payload too long or too
/// private for a command line — a pull request body, a token.
pub fn run_oneshot(
    name: &str,
    dev_entry: &str,
    args: &[&str],
    env: &[(&str, &str)],
    stdin_data: Option<&str>,
) -> Result<serde_json::Value, String> {
    use std::io::Write;

    let mut command = sidecar_command(name, dev_entry);
    command
        .args(args)
        .envs(env.iter().copied())
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn {name}: {error}"))?;
    if let Some(data) = stdin_data {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("{name} stdin unavailable"))?;
        stdin
            .write_all(data.as_bytes())
            .map_err(|error| format!("write to {name}: {error}"))?;
        // Dropping the handle closes the pipe, which is what tells a sidecar
        // reading all of stdin that the payload is complete.
        drop(stdin);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("run {name}: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .next_back();
    let Some(value) = last else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{name} produced no result: {}", stderr.trim()));
    };
    // The sidecar reports its own failures as an `error` event; a non-zero exit
    // with no such event still has to fail rather than look like success.
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(error.to_string());
    }
    if !output.status.success() {
        return Err(format!("{name} exited with {}", output.status));
    }
    Ok(value)
}
