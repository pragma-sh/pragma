//! Killing processes and asking whether one is still alive.
//!
//! Pragma supervises processes it did not spawn as children — a detached
//! server recorded in a lock file, a superseded gateway named in a discovery
//! file. Those are addressed by pid, which means every caller needs the same
//! two things: a way to end the process, and a way to confirm the pid still
//! belongs to the program it claims to (pids get recycled, and killing a
//! recycled pid kills an unrelated program).
//!
//! Unix does this with `kill`/`pkill`/`ps`; Windows with `taskkill`/`tasklist`.
//! Both are wrapped here so no caller has to know which it is running on.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

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
/// parent/child chain rather than one process at a time.
pub fn list_processes() -> Result<HashMap<u32, ProcessEntry>, String> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args(["-axo", "pid=,ppid=,comm="])
            .output()
            .map_err(|error| format!("failed to inspect processes: {error}"))?;
        if !output.status.success() {
            return Err(format!("process inspection exited with {}", output.status));
        }
        let mut processes = parse_ps(&String::from_utf8_lossy(&output.stdout));
        enrich_truncated_names(&mut processes);
        Ok(processes)
    }
    #[cfg(windows)]
    {
        // `tasklist` does not report a parent pid, and `wmic` is deprecated and
        // absent from recent Windows builds. CIM through PowerShell is the
        // supported way to read the parent/child chain.
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | \
                 ConvertTo-Csv -NoTypeInformation",
            ])
            .output()
            .map_err(|error| format!("failed to inspect processes: {error}"))?;
        if !output.status.success() {
            return Err(format!("process inspection exited with {}", output.status));
        }
        Ok(parse_win32_process_csv(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }
}

/// Parses `ps -axo pid=,ppid=,comm=` output.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_ps(output: &str) -> HashMap<u32, ProcessEntry> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let parent_pid = fields.next()?.parse().ok()?;
            let command = fields.next()?;
            Some((
                pid,
                ProcessEntry {
                    parent_pid,
                    name: base_name(command),
                },
            ))
        })
        .collect()
}

/// Parses `Win32_Process` rows converted to CSV.
///
/// The header row is skipped, and rows whose pid or parent pid do not parse are
/// dropped rather than defaulted — a process attributed to the wrong parent
/// would show its ports under an unrelated terminal session.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_win32_process_csv(output: &str) -> HashMap<u32, ProcessEntry> {
    output
        .lines()
        .skip_while(|line| !line.starts_with('"'))
        .filter_map(|line| {
            let fields: Vec<&str> = line.split("\",\"").collect();
            let [pid, parent_pid, name] = fields.as_slice() else {
                return None;
            };
            let pid = pid.trim_start_matches('"').parse().ok()?;
            let parent_pid = parent_pid.parse().ok()?;
            let name = name.trim_end_matches('"');
            Some((
                pid,
                ProcessEntry {
                    parent_pid,
                    name: base_name(name),
                },
            ))
        })
        .collect()
}

/// Strips any directory part from a program path.
fn base_name(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_string()
}

/// `ps comm=` is sourced from the kernel's `TASK_COMM_LEN` field, which Linux
/// caps at 15 characters — longer names (`vite-dev-server`, `python3-watchdog`)
/// arrive already truncated. `/proc/<pid>/cmdline` carries the untruncated
/// `argv[0]`, so on Linux it is preferred when available, falling back to the
/// `ps`-derived name for processes that exit before it can be read (or when
/// `/proc` is unavailable, e.g. inside some sandboxes). macOS's `ps comm=` is
/// not subject to this cap, so no enrichment is needed there.
#[cfg(target_os = "linux")]
fn enrich_truncated_names(processes: &mut HashMap<u32, ProcessEntry>) {
    for (pid, entry) in processes.iter_mut() {
        if let Some(name) = linux_cmdline_name(*pid) {
            entry.name = name;
        }
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn enrich_truncated_names(_processes: &mut HashMap<u32, ProcessEntry>) {}

#[cfg(target_os = "linux")]
fn linux_cmdline_name(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let arg0 = bytes
        .split(|&byte| byte == 0)
        .find(|segment| !segment.is_empty())?;
    Some(base_name(std::str::from_utf8(arg0).ok()?))
}

/// Ends a single process immediately.
///
/// Returns whether the process was signalled. A `false` result usually means
/// the pid is already gone, which callers generally treat as success.
#[must_use]
pub fn kill(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(windows)]
    {
        Command::new("taskkill")
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
        let _ = Command::new("pkill")
            .args(["-KILL", "-P", &pid.to_string()])
            .status();
        kill(pid)
    }
    #[cfg(windows)]
    {
        Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output()
            .is_ok_and(|output| output.status.success())
    }
}

/// Ends every process whose command line mentions `pattern`.
///
/// This is the blunt fallback used when a recorded pid is unusable. On Windows
/// the match is against the image name, so `pattern` is resolved to
/// `pattern.exe` when it carries no extension.
pub fn kill_matching(pattern: &str) {
    #[cfg(unix)]
    {
        let _ = Command::new("pkill")
            .args(["-KILL", "-f", pattern])
            .status();
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
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", &image])
            .output();
    }
}

/// Reads the executable name a pid currently belongs to.
///
/// Returns `None` when the process is gone or cannot be inspected. Callers use
/// this to confirm a recorded pid has not been recycled before killing it.
#[must_use]
pub fn process_name(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
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
        let output = Command::new("tasklist")
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
    use super::{
        is_running, list_processes, parse_ps, parse_tasklist_image_name, parse_win32_process_csv,
        process_name, ProcessEntry,
    };

    #[test]
    fn the_host_process_table_includes_this_process() {
        let processes = list_processes().expect("the process table is listable");
        assert!(
            processes.contains_key(&std::process::id()),
            "the running test process must appear in the process table"
        );
    }

    #[test]
    fn ps_rows_yield_pid_parent_and_name() {
        let parsed = parse_ps("  501   1 /bin/zsh\n  502 501 node\n");
        assert_eq!(
            parsed.get(&501),
            Some(&ProcessEntry {
                parent_pid: 1,
                name: "zsh".to_string()
            })
        );
        assert_eq!(
            parsed.get(&502),
            Some(&ProcessEntry {
                parent_pid: 501,
                name: "node".to_string()
            })
        );
    }

    #[test]
    fn win32_process_rows_yield_pid_parent_and_name() {
        let output = "\"ProcessId\",\"ParentProcessId\",\"Name\"\r\n\
                      \"4242\",\"1200\",\"node.exe\"\r\n\
                      \"1200\",\"800\",\"pwsh.exe\"\r\n";
        let parsed = parse_win32_process_csv(output);
        assert_eq!(
            parsed.get(&4242),
            Some(&ProcessEntry {
                parent_pid: 1200,
                name: "node.exe".to_string()
            })
        );
        assert_eq!(
            parsed.get(&1200),
            Some(&ProcessEntry {
                parent_pid: 800,
                name: "pwsh.exe".to_string()
            })
        );
    }

    /// A row that cannot be parsed must be dropped, not defaulted: a process
    /// recorded with parent pid 0 would be attributed to the wrong terminal
    /// session and leak another session's ports into this one's port list.
    #[test]
    fn unparsable_process_rows_are_dropped() {
        let output = "\"ProcessId\",\"ParentProcessId\",\"Name\"\r\n\
                      \"notapid\",\"1200\",\"node.exe\"\r\n\
                      \"4242\",\"alsonotapid\",\"node.exe\"\r\n";
        assert!(parse_win32_process_csv(output).is_empty());
    }

    #[test]
    fn a_header_only_process_listing_is_empty() {
        assert!(
            parse_win32_process_csv("\"ProcessId\",\"ParentProcessId\",\"Name\"\r\n").is_empty()
        );
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
