//! Killing processes and asking whether one is still alive.
//!
//! Pragma supervises processes it did not spawn as children — a detached
//! server recorded in a lock file, a superseded gateway named in a discovery
//! file. Those are addressed by pid, which means every caller needs the same
//! two things: a way to end the process, and a way to confirm the pid still
//! belongs to the program it claims to (pids get recycled, and killing a
//! recycled pid kills an unrelated program).
//!
//! Process-table snapshots use `sysinfo`; termination and one-pid liveness
//! checks use `kill`/`pkill`/`ps` on Unix and `taskkill`/`tasklist` on Windows.
//! They are wrapped here so no caller has to know which it is running on.
//!
//! The platform helpers are *console* programs, which is why this module also
//! owns [`command`]/[`hide_console`]: on Windows a console program spawned from
//! a GUI process gets its own console window unless told otherwise.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

/// Creates a child-process command that never flashes a console window.
///
/// Prefer this over `Command::new` for anything Pragma runs on the user's
/// behalf. See [`hide_console`] for why.
#[must_use]
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    hide_console(&mut command);
    command
}

/// Suppresses the console window Windows gives a console program spawned from
/// a GUI process. No-op on Unix.
///
/// Pragma's UI process shells out frequently — `git` on status refresh and
/// `wsl.exe` when enumerating distributions. Without `CREATE_NO_WINDOW` each
/// invocation is a console window that pops up, steals focus, and vanishes.
/// Process-table polling does not shell out; [`list_processes`] uses `sysinfo`.
///
/// This is deliberately separate from the detach flags in `pragma-client`'s
/// server spawn: those additionally cut the child loose from this process's
/// console and process group, which a short-lived query must *not* do.
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Windows process-creation flag: run a console program with no console window.
///
/// Exported for spawners that cannot take a `std::process::Command` — notably
/// `tokio::process::Command`, whose `creation_flags` is its own method — so the
/// value itself still has exactly one definition.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A process in the host's process table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessEntry {
    /// Pid of this process's parent, used to walk descendants of a shell.
    pub parent_pid: u32,
    /// Executable file name, without any directory part.
    pub name: String,
}

/// Lists every process on the host, keyed by pid.
///
/// Used to attribute a listening TCP port to the terminal session that
/// ultimately spawned the process holding it, which needs the whole
/// parent/child chain rather than one process at a time. The `System` is kept
/// between calls so the two-second port poll refreshes a native snapshot
/// instead of spawning and parsing a new `ps` or PowerShell process.
pub fn list_processes() -> Result<HashMap<u32, ProcessEntry>, String> {
    static PROCESS_SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

    let mut system = PROCESS_SYSTEM
        .get_or_init(|| Mutex::new(System::new()))
        .lock()
        .map_err(|error| format!("failed to inspect processes: {error}"))?;
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());

    Ok(system
        .processes()
        .iter()
        .map(|(&pid, process)| {
            (
                pid.as_u32(),
                ProcessEntry {
                    parent_pid: process.parent().map_or(0, sysinfo::Pid::as_u32),
                    name: process_entry_name(process),
                },
            )
        })
        .collect())
}

/// Linux's kernel process name is capped at 15 bytes, so load `argv[0]` once
/// when a process first appears. This preserves the full names the old `/proc`
/// enrichment returned without rereading every command line on every poll.
fn process_refresh_kind() -> ProcessRefreshKind {
    let refresh_kind = ProcessRefreshKind::nothing();
    #[cfg(target_os = "linux")]
    let refresh_kind = refresh_kind.with_cmd(sysinfo::UpdateKind::OnlyIfNotSet);
    refresh_kind
}

fn process_entry_name(process: &sysinfo::Process) -> String {
    #[cfg(target_os = "linux")]
    let name = process
        .cmd()
        .first()
        .map_or(process.name(), std::ffi::OsString::as_os_str);
    #[cfg(not(target_os = "linux"))]
    let name = process.name();
    base_name(&name.to_string_lossy())
}

/// Strips any directory part from a program path.
fn base_name(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_string()
}

/// Ends a single process immediately.
///
/// Returns whether the process was signalled. A `false` result usually means
/// the pid is already gone, which callers generally treat as success — so the
/// helper's own output is captured rather than inherited, like the Windows
/// branch below. Otherwise every such call leaks `kill: 1234: No such process`
/// into the caller's stderr, which reads as a failure of whatever was running.
#[must_use]
pub fn kill(pid: u32) -> bool {
    #[cfg(unix)]
    {
        command("kill")
            .args(["-KILL", &pid.to_string()])
            .output()
            .is_ok_and(|output| output.status.success())
    }
    #[cfg(windows)]
    {
        command("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .is_ok_and(|output| output.status.success())
    }
}

/// Ends a process together with everything it spawned.
///
/// On Windows `taskkill /T` walks the parent/child chain, which is the
/// supported way to reach the whole tree without opening a job object — that
/// would need the Win32 API and therefore `unsafe`, which this workspace
/// forbids. On Unix the direct children are killed first so they cannot be
/// reparented to init and outlive the request.
#[must_use]
pub fn kill_tree(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let _ = command("pkill")
            .args(["-KILL", "-P", &pid.to_string()])
            .status();
        kill(pid)
    }
    #[cfg(windows)]
    {
        command("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output()
            .is_ok_and(|output| output.status.success())
    }
}

/// Ends `pid` together with every process descended from it, at any depth.
///
/// [`kill_tree`] only reaches one generation (`pkill -P`/`taskkill /T`'s
/// direct-child view), and a process-group signal (`kill -- -pid`) misses a
/// backgrounded job entirely: an interactive shell's job control puts each
/// `cmd &` in a *new* process group of its own, so it never shares the
/// shell's group even though it stays the shell's child. This instead reads
/// the whole process table once ([`list_processes`]) and walks it by parent
/// pid — which job control does not change — so it reaches a backgrounded
/// job and anything that job goes on to fork, not just what stayed in the
/// shell's own process group.
#[must_use]
pub fn kill_process_tree(pid: u32) -> bool {
    let Ok(processes) = list_processes() else {
        return kill_tree(pid);
    };
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&child_pid, entry) in &processes {
        children_by_parent
            .entry(entry.parent_pid)
            .or_default()
            .push(child_pid);
    }
    let mut descendants = vec![pid];
    let mut visited = std::collections::HashSet::from([pid]);
    let mut frontier = vec![pid];
    while let Some(next) = frontier.pop() {
        for &child in children_by_parent.get(&next).into_iter().flatten() {
            if visited.insert(child) {
                descendants.push(child);
                frontier.push(child);
            }
        }
    }
    // The whole tree was captured from one snapshot before any signal went
    // out, so kill order does not matter: every pid killed here was already
    // a confirmed descendant, regardless of which of its ancestors dies (and
    // gets reparented away from) first.
    let mut root_killed = false;
    for target in descendants {
        let ok = kill(target);
        root_killed |= ok && target == pid;
    }
    root_killed
}

/// Ends every matching process together with everything it spawned.
///
/// This is the blunt fallback used when a recorded pid is unusable. Matching
/// only roots first is important: killing a parent before discovering its
/// children reparents them and loses the ancestry needed for cleanup. When the
/// process table cannot be read, the platform command remains a best-effort
/// last resort (`taskkill /T` still handles the full tree on Windows).
pub fn kill_matching(pattern: &str) {
    if let Ok(processes) = list_processes() {
        for pid in matching_process_roots(&processes, pattern) {
            let _ = kill_process_tree(pid);
        }
        return;
    }
    #[cfg(unix)]
    {
        let _ = command("pkill").args(["-KILL", "-f", pattern]).status();
    }
    #[cfg(windows)]
    {
        let image = if std::path::Path::new(pattern)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            pattern.to_string()
        } else {
            format!("{pattern}.exe")
        };
        let _ = command("taskkill")
            .args(["/F", "/T", "/IM", &image])
            .output();
    }
}

/// Finds matching process roots, excluding a match descended from another
/// match so each tree is snapshotted and killed exactly once.
fn matching_process_roots(processes: &HashMap<u32, ProcessEntry>, pattern: &str) -> Vec<u32> {
    let pattern = pattern.to_ascii_lowercase();
    let matching: std::collections::HashSet<u32> = processes
        .iter()
        .filter_map(|(&pid, entry)| {
            entry
                .name
                .to_ascii_lowercase()
                .contains(&pattern)
                .then_some(pid)
        })
        .collect();
    matching
        .iter()
        .copied()
        .filter(|pid| {
            let mut visited = std::collections::HashSet::new();
            let mut parent = processes.get(pid).map(|entry| entry.parent_pid);
            while let Some(parent_pid) = parent {
                if matching.contains(&parent_pid) {
                    return false;
                }
                if !visited.insert(parent_pid) {
                    break;
                }
                parent = processes.get(&parent_pid).map(|entry| entry.parent_pid);
            }
            true
        })
        .collect()
}

/// Reads the executable name a pid currently belongs to.
///
/// Returns `None` when the process is gone or cannot be inspected. Callers use
/// this to confirm a recorded pid has not been recycled before killing it.
#[must_use]
pub fn process_name(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let output = command("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!name.is_empty()).then_some(name)
    }
    #[cfg(windows)]
    {
        let output = command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_tasklist_image_name(&String::from_utf8_lossy(&output.stdout))
    }
}

/// Whether a pid is alive *and* still running the expected program.
///
/// The name is compared as a substring so callers can pass `"pragma-gateway"`
/// and match `pragma-gateway.exe`.
#[must_use]
pub fn is_running(pid: u32, expected_name: &str) -> bool {
    process_name(pid).is_some_and(|name| name.contains(expected_name))
}

/// Extracts the image name from a `tasklist /FO CSV /NH` row.
///
/// A miss is reported as `None` rather than a fabricated name: `tasklist`
/// prints an informational line ("No tasks are running...") on stdout with a
/// success status when the filter matches nothing, so an unparsed row must not
/// be mistaken for a live process.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_tasklist_image_name(output: &str) -> Option<String> {
    let row = output.lines().find(|line| line.starts_with('"'))?;
    let name = row.split('"').nth(1)?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        is_running, list_processes, matching_process_roots, parse_tasklist_image_name,
        process_name, ProcessEntry,
    };

    #[test]
    fn the_host_process_table_includes_this_process() {
        let processes = list_processes().expect("the process table is listable");
        let current = processes
            .get(&std::process::id())
            .expect("the running test process must appear in the process table");
        assert!(!current.name.is_empty(), "the process name must be present");
        #[cfg(target_os = "linux")]
        assert_eq!(
            current.name,
            std::env::current_exe()
                .expect("the test executable path is available")
                .file_name()
                .expect("the test executable has a file name")
                .to_string_lossy(),
            "Linux process names must not be truncated to TASK_COMM_LEN",
        );
    }

    #[test]
    fn matching_processes_nested_under_a_match_share_one_root() {
        let processes = HashMap::from([
            (
                10,
                ProcessEntry {
                    parent_pid: 1,
                    name: "pragma-server".to_string(),
                },
            ),
            (
                11,
                ProcessEntry {
                    parent_pid: 10,
                    name: "pragma-server-helper".to_string(),
                },
            ),
            (
                12,
                ProcessEntry {
                    parent_pid: 11,
                    name: "bun".to_string(),
                },
            ),
            (
                20,
                ProcessEntry {
                    parent_pid: 1,
                    name: "PRAGMA-SERVER.EXE".to_string(),
                },
            ),
        ]);

        let mut roots = matching_process_roots(&processes, "pragma-server");
        roots.sort_unstable();
        assert_eq!(roots, [10, 20]);
    }

    #[test]
    fn the_current_process_is_inspectable() {
        let pid = std::process::id();
        assert!(
            process_name(pid).is_some(),
            "the running test process must be visible to the process lister"
        );
    }

    /// Pid 0 is never a real user process on any supported platform, so it
    /// stands in for the recycled/dead pid a caller must not kill blindly.
    #[test]
    fn an_absent_process_reports_no_name() {
        assert!(!is_running(0, "pragma-gateway"));
    }

    #[test]
    fn a_tasklist_row_yields_its_image_name() {
        let output = "\"pragma-gateway.exe\",\"4242\",\"Console\",\"1\",\"9,000 K\"\r\n";
        assert_eq!(
            parse_tasklist_image_name(output).as_deref(),
            Some("pragma-gateway.exe")
        );
    }

    /// `tasklist` exits successfully when its filter matches nothing. Treating
    /// that message as a process name would make a dead pid look alive, and the
    /// recycled-pid guard would then wave through a kill it should refuse.
    #[test]
    fn a_tasklist_miss_is_not_mistaken_for_a_process() {
        let output = "INFO: No tasks are running which match the specified criteria.\r\n";
        assert_eq!(parse_tasklist_image_name(output), None);
    }

    #[test]
    fn an_empty_tasklist_response_yields_nothing() {
        assert_eq!(parse_tasklist_image_name(""), None);
    }
}
