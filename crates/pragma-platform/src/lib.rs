//! Operating-system primitives shared by every Pragma crate.
//!
//! Pragma runs the same session, gateway, and client code on macOS, Linux, and
//! Windows. The differences between those systems are deliberately collected
//! here instead of being spread across `#[cfg(unix)]` blocks at the call sites,
//! so a platform gap is a missing implementation in one crate rather than a
//! guarantee that silently evaporates somewhere in the tree.
//!
//! Five seams live here:
//!
//! - [`ipc`] — the local socket the server binds and clients connect to.
//! - [`path`] — canonical paths external programs can read back.
//! - [`perms`] — owner-only files and directories.
//! - [`process`] — killing a process, asking whether one is alive, and
//!   spawning a child without flashing a console window.
//! - [`shell`] — resolving the interactive shell a PTY should launch.

pub mod ipc;
pub mod path;
pub mod perms;
pub mod process;
pub mod shell;
