//! Enumerating the WSL distributions installed on a machine.
//!
//! The probe compiles on every platform and reports nothing where `wsl.exe`
//! does not exist, so callers need no `cfg` of their own — and the parser is
//! plain string handling, so CI on Linux and macOS exercises it too.
//!
//! It lives in this crate rather than in `pragma-client` because both ends of
//! the wire need it. `pragma-client` uses it to pick a distribution to bridge
//! into; `pragma-server` answers the `wsl` RPC with it, so a desktop app asks
//! *the host that owns a worktree* what it has installed instead of assuming
//! its own machine does. Those are different machines whenever a project is
//! opened over SSH, and the wrong answer is doubly wrong: it hides the remote
//! host's distributions and offers local ones the remote daemon cannot launch.

use std::num::NonZeroU64;

use pragma_constants::{WslDistro, WslDistroList, CONSTANTS};
use thiserror::Error;

/// Errors raised while enumerating distributions.
#[derive(Debug, Error)]
pub enum WslError {
    /// `wsl.exe` is absent, i.e. WSL is not available on this machine.
    #[error("WSL is not available on this machine: {0}")]
    Unavailable(String),
    /// `wsl.exe` ran but reported a failure.
    #[error("wsl exited with {status}: {message}")]
    Failed { status: String, message: String },
}

/// Whether this machine is one where WSL distributions can exist at all.
#[must_use]
pub fn is_windows() -> bool {
    cfg!(windows)
}

/// Lists the installed WSL distributions, tagged with the host's platform.
///
/// The `is_windows` flag is what tells a caller apart "this host has no
/// distributions installed" from "this host could never have any", which is the
/// difference between offering the user a way to install one and hiding the
/// feature entirely.
pub fn list_distros() -> Result<WslDistroList, WslError> {
    let launcher = &CONSTANTS.platform.wsl.launcher;
    let args: Vec<&str> = CONSTANTS
        .platform
        .wsl
        .list_args
        .iter()
        .map(String::as_str)
        .collect();
    let output = crate::process::command(launcher)
        .args(&args)
        .output()
        .map_err(|error| WslError::Unavailable(error.to_string()))?;
    if !output.status.success() {
        return Err(WslError::Failed {
            status: output.status.to_string(),
            message: decode_utf16le(&output.stderr).trim().to_string(),
        });
    }
    Ok(WslDistroList {
        is_windows: is_windows(),
        distros: parse_distros(&decode_utf16le(&output.stdout)),
    })
}

/// The list a host reports when the probe itself failed.
///
/// A failing probe (no `wsl.exe`, no distributions, a WSL error) is not an
/// error to the caller — it is "WSL is not available here", which hides every
/// WSL-dependent affordance. The platform flag still has to be truthful.
#[must_use]
pub fn empty_list() -> WslDistroList {
    WslDistroList {
        is_windows: is_windows(),
        distros: Vec::new(),
    }
}

/// Decodes `wsl.exe` output, which is UTF-16LE rather than the UTF-8 every
/// other tool Pragma shells out to produces.
///
/// Falls back to a lossy UTF-8 read when the byte count is odd, which is what a
/// non-UTF-16 error message from a failed launch looks like.
fn decode_utf16le(bytes: &[u8]) -> String {
    if !bytes.len().is_multiple_of(2) {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    String::from_utf16_lossy(&units)
}

/// Parses the table `wsl --list --verbose` prints.
///
/// The header row is skipped, and a leading `*` marks the default
/// distribution. Rows that do not carry all three columns are dropped rather
/// than partially filled, so a distribution is never reported with a wrong
/// version.
fn parse_distros(output: &str) -> Vec<WslDistro> {
    output
        .lines()
        .map(|line| line.trim_start_matches('\u{feff}').trim_end())
        .filter(|line| !line.trim().is_empty())
        .skip(1)
        .filter_map(|line| {
            let default = line.trim_start().starts_with('*');
            let rest = line.trim_start().trim_start_matches('*').trim();
            let mut fields = rest.split_whitespace();
            let name = fields.next()?.to_string();
            let state = fields.next()?;
            // The schema pins the version to >= 1, so it is a `NonZero`. WSL
            // only ever reports 1 or 2; a parsed 0 falls back to 1 rather than
            // dropping the distribution.
            let version = NonZeroU64::new(fields.next()?.parse().ok()?).unwrap_or(NonZeroU64::MIN);
            Some(WslDistro {
                name,
                running: state.eq_ignore_ascii_case("Running"),
                version,
                default,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use pragma_constants::WslDistro;

    use super::{decode_utf16le, parse_distros};

    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    fn version(value: u64) -> NonZeroU64 {
        NonZeroU64::new(value).expect("a non-zero WSL version")
    }

    #[test]
    fn wsl_output_is_decoded_from_utf16() {
        assert_eq!(decode_utf16le(&utf16le("Ubuntu")), "Ubuntu");
    }

    /// A failed launch can print a plain byte string rather than UTF-16. That
    /// must still be readable, because it is the message the user is shown.
    #[test]
    fn an_odd_length_response_is_read_as_utf8() {
        assert_eq!(decode_utf16le(b"wsl not found"), "wsl not found");
    }

    #[test]
    fn distributions_are_parsed_with_their_default_marked() {
        let output = "  NAME      STATE           VERSION\n\
                      * Ubuntu    Running         2\n\
                        Debian    Stopped         2\n";
        assert_eq!(
            parse_distros(output),
            vec![
                WslDistro {
                    name: "Ubuntu".to_string(),
                    running: true,
                    version: version(2),
                    default: true,
                },
                WslDistro {
                    name: "Debian".to_string(),
                    running: false,
                    version: version(2),
                    default: false,
                },
            ]
        );
    }

    /// `wsl.exe` emits a UTF-16 byte-order mark; leaving it attached would make
    /// the first distribution's name fail to match the one the user configured.
    #[test]
    fn a_byte_order_mark_does_not_contaminate_the_first_row() {
        let output = "\u{feff}  NAME    STATE     VERSION\n* Ubuntu  Running   2\n";
        let parsed = parse_distros(output);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "Ubuntu");
    }

    #[test]
    fn a_machine_with_no_distributions_parses_to_nothing() {
        assert!(parse_distros("  NAME  STATE  VERSION\n").is_empty());
    }

    /// A row missing its version column must be dropped: defaulting the version
    /// would report a WSL1 distribution as WSL2 (or the reverse), and the two
    /// differ in exactly the networking behaviour the bridge works around.
    #[test]
    fn an_incomplete_row_is_dropped() {
        let output = "  NAME    STATE     VERSION\n* Ubuntu  Running\n";
        assert!(parse_distros(output).is_empty());
    }

    /// A version of `0` is not something WSL prints, but the schema forbids it
    /// and dropping the row would hide a usable distribution from the picker.
    #[test]
    fn a_zero_version_is_clamped_rather_than_dropped() {
        let output = "  NAME    STATE     VERSION\n* Ubuntu  Running   0\n";
        let parsed = parse_distros(output);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].version, NonZeroU64::MIN);
    }

    /// The empty list is what every failed probe degrades to, so it must still
    /// tell the truth about the platform it was taken on.
    #[test]
    fn the_empty_list_still_reports_the_host_platform() {
        assert_eq!(super::empty_list().is_windows, cfg!(windows));
        assert!(super::empty_list().distros.is_empty());
    }
}
