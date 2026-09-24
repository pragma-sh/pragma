//! Operating-system primitives shared by every Pragma crate.
//!
//! Pragma runs the same session, gateway, and client code on macOS, Linux, and
//! Windows. The differences between those systems are deliberately collected
//! here instead of being spread across `#[cfg(unix)]` blocks at the call sites,
//! so a platform gap is a missing implementation in one crate rather than a
//! guarantee that silently evaporates somewhere in the tree.
//!
//! Eight seams live here:
//!
//! - [`install`] — replacing the installed desktop app with a downloaded build
//!   and relaunching it.
//! - [`ipc`] — the local socket the server binds and clients connect to.
//! - [`path`] — canonical paths external programs can read back.
//! - [`perms`] — owner-only files and directories.
//! - [`power`] — keeping the system awake while a remote client is served.
//! - [`process`] — killing a process, asking whether one is alive, and
//!   spawning a child without flashing a console window.
//! - [`shell`] — resolving the interactive shell a PTY should launch.
//! - [`wsl`] — enumerating the WSL distributions a machine has installed.

pub mod install;
pub mod ipc;
pub mod path;
pub mod perms;
pub mod power;
pub mod process;
pub mod shell;
pub mod wsl;
