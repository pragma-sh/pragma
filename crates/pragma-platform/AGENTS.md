# `pragma-platform` — operating-system seams

Every place Pragma behaves differently on macOS, Linux, or Windows lives here. Nothing
else in the workspace should carry a `#[cfg(unix)]` for a platform _capability_.

## Why this crate exists

Before it, platform differences were `#[cfg(unix)]` blocks at the call sites, each with a
`#[cfg(not(unix))]` twin. Several of those twins silently did nothing — the GitHub OAuth
token was created `0600` on Unix and with `fs::write` and default inheritance on Windows.
Nothing failed; the guarantee just evaporated.

**The rule that follows: a platform difference is a missing implementation in one crate,
never a quietly-empty branch at a call site.** If you cannot implement a seam on a
target, return an `Err` that says so. Do not no-op.

## The five seams

| Module    | Unix                                 | Windows                                                 |
| --------- | ------------------------------------ | ------------------------------------------------------- |
| `ipc`     | `std::os::unix::net`                 | `uds_windows` (`AF_UNIX`, Windows 10 1803+)             |
| `path`    | `std::fs::canonicalize`              | …then strip the `\\?\` verbatim prefix                  |
| `perms`   | `chmod` `0600`/`0700`                | `icacls /inheritance:r /grant:r <user>:(F)`             |
| `process` | `kill`, `pkill`, `ps`                | `taskkill`, `tasklist`, `Get-CimInstance Win32_Process` |
| `shell`   | `$SHELL`, else the constants default | probe `pwsh.exe` then `powershell.exe`                  |

### `path` — a canonical path git can read back

`std::fs::canonicalize` on Windows returns an extended-length path,
`\\?\C:\Users\dev\project`. That prefix is a Win32 API convention, not something other
programs parse: git reads it as the UNC path `//?/C:/…` and `git worktree add` dies with
`could not create leading directories … Invalid argument`. Pragma stores canonical
project roots and then hands them to git, so **every canonicalization goes through
`path::canonicalize`**, never `std`'s directly.

Two consequences that bite if you forget:

- A verbatim path never `starts_with` a plain one. Both sides of a containment check
  (`fs::resolve_in_worktree`) must use the same canonicalizer or the check rejects
  everything on Windows.
- Paths at or past `MAX_PATH` keep the prefix, because there it is what makes them
  openable at all.

### `process` — also the console-window seam

On Windows a _console_ program spawned from a GUI process gets its own console window. All
four helpers here are console programs, and so is nearly everything Pragma shells out to
(`git`, `wsl.exe`, sidecars). Without `CREATE_NO_WINDOW` the user sees windows popping up
and vanishing on a timer — the process-table poll for port attribution alone is one per
tick. Spawn through `process::command`, or apply `process::hide_console` to a command you
built yourself; `CREATE_NO_WINDOW` is exported for spawners that cannot take a
`std::process::Command` (tokio's has its own `creation_flags`).

This is _not_ the same as the detach flags in `pragma-client`'s server spawn
(`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`), which additionally cut
the child loose from this process's console and process group. A short-lived query must
not do that.

### `ipc` — why `AF_UNIX` and not named pipes

Windows named pipes have **no read timeout and no socket-style `shutdown`**. This codebase
depends on both: the server wakes a reader blocked on a socket by shutting that socket
down from another thread (`pragma-server/src/main.rs`, `gateway/http/response.rs`,
`src-tauri/src/pty.rs`). Emulating that over pipes means overlapped I/O plus `CancelIoEx`,
which needs `unsafe` — forbidden workspace-wide — for no behavioural gain on a
local-only transport. `AF_UNIX` keeps `set_read_timeout`, `try_clone`, `shutdown`, and
`pair` working identically, so call sites are the same on every platform.

Consequences worth knowing:

- A Unix-domain address has a **108-byte limit**, on Windows too. `check_socket_path`
  turns an overrun into a readable error instead of an opaque `InvalidInput` from `bind`.
- There is no peer-credential API (no `SO_PEERCRED`). Nothing uses one today; gateway auth
  is token-based. If you ever need to authenticate the _connecting process_, this choice
  has to be revisited.
- Socket files must be spelled from `@pragma/constants` (`ipc::socket_file_name()` and
  friends), never inline.

### `perms` — `icacls`, not the Win32 API

`unsafe_code = "forbid"` is set workspace-wide and every Rust binding to the Windows
security APIs needs `unsafe`. `icacls` is the in-box tool for the job, and the call is
**checked** — a failure returns `Err` rather than leaving a secret readable.
`create_private_file` applies the restriction to the _empty_ file before returning the
handle, so contents are never briefly on disk under looser permissions.

`set_executable` is the one honest no-op: Windows decides executability by extension, so
there is no bit to set and nothing is lost.

### `shell` — PowerShell does not take `-l`

`-l` abbreviates `-Login` in PowerShell, which is an error on Windows. Passing it would
fail every terminal Pragma opens. Use `shell::resolve_launch`, which returns the program
_and_ its interactive arguments together — never hardcode `-l` at a call site. For
non-interactive commands, use `shell::default_shell` with `shell::command_args`; Windows
PowerShell takes `-Command`, `cmd.exe` takes `/C`, and POSIX shells take `-c`.

Note `stem()` splits on both `/` and `\` rather than deferring to `Path::file_stem`,
which only recognises the host's separator. A test caught this: a Windows PowerShell path
examined on a Unix CI runner came back whole and fell through to the POSIX branch.

## Adding a seam

1. Add the module here with a real implementation for every target.
2. Put any tunable default in `@pragma/constants` under `platform`, not in Rust.
3. Test the platform-independent core on every platform. Parsers for foreign-OS output
   (`parse_tasklist_image_name`, `parse_win32_process_csv`, `parse_distros`) are plain
   string handling — write them so they compile and run everywhere, or CI on Linux and
   macOS will never exercise them.
4. Verify with `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`.
   The GNU target needs no Windows machine and is `cfg`-identical to MSVC.
