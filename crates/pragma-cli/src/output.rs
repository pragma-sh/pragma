//! Plain-text vs `--json` output helpers.
//!
//! Default output is plain text on stdout (lists as aligned columns via
//! `comfy-table`, single objects as short human-readable lines). With the global
//! `--json` flag each command serializes its structured result directly with
//! `serde_json`. Errors always go to stderr.

use comfy_table::{ContentArrangement, Table};

/// The status the CLI currently prints under, controlling whether structured
/// JSON or human-readable plain text is emitted.
pub struct Output {
    pub json: bool,
}

impl Output {
    /// Prints a human-readable line by default, and the serialized `value` under
    /// `--json`.
    pub fn line(&self, human: impl std::fmt::Display, value: &impl serde::Serialize) {
        if self.json {
            let _ = serde_json::to_writer(std::io::stdout(), value);
            println!();
        } else {
            println!("{human}");
        }
    }

    /// Prints a list: a `comfy-table` of `rows` by default, or a JSON array
    /// under `--json`. `headers` is the column labels. `row` extracts a tuple
    /// of cells per item for the table; each cell is stringified as-is.
    pub fn list<T, S, const N: usize>(
        &self,
        headers: [&str; N],
        items: &[T],
        row: impl Fn(&T) -> [S; N],
        value: &impl serde::Serialize,
    ) where
        S: std::string::ToString,
    {
        if self.json {
            let _ = serde_json::to_writer(std::io::stdout(), value);
            println!();
            return;
        }
        if items.is_empty() {
            return;
        }
        let mut table = Table::new();
        table
            .load_preset(comfy_table::presets::UTF8_FULL)
            .apply_modifier(comfy_table::modifiers::UTF8_ROUND_CORNERS)
            .set_content_arrangement(ContentArrangement::Disabled)
            .set_header(headers.iter().copied());
        for item in items {
            let cells = row(item);
            table.add_row(cells.iter().map(std::string::ToString::to_string));
        }
        println!("{table}");
    }
}

/// The canonical "app not running" message used by every brokered command when
/// no controller is registered with the server.
pub const APP_NOT_RUNNING: &str = "Pragma is not running. Launch the app first.";

/// True when the given error string is the app-not-running signal returned by
/// the server (or the timeout equivalent). Scripts can branch on it.
pub fn is_app_not_running(error: &str) -> bool {
    error.contains(APP_NOT_RUNNING) || error.contains("timed out")
}
