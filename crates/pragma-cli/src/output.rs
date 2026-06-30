//! Plain-text vs `--json`/`--toon` output helpers.
//!
//! Default output is plain text on stdout (lists as aligned columns via
//! `comfy-table`, single objects as short human-readable lines). With the global
//! `--json` flag each command serializes its structured result directly with
//! `serde_json`. With `--toon` the same structured result is instead encoded as
//! [TOON](https://toonformat.dev), a token-efficient JSON alternative meant for
//! LLM contexts. `--json` and `--toon` are mutually exclusive. Errors always go
//! to stderr.

use comfy_table::{ContentArrangement, Table};

/// Which structured format (if any) a command should emit instead of plain text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Aligned tables / short human-readable lines (the default).
    Text,
    /// `serde_json`-serialized output.
    Json,
    /// TOON-encoded output, via the `toon-format` crate.
    Toon,
}

/// The status the CLI currently prints under, controlling whether structured
/// output (JSON or TOON) or human-readable plain text is emitted.
pub struct Output {
    pub format: Format,
}

impl Output {
    /// True when the command should emit a structured format instead of plain
    /// text (i.e. `--json` or `--toon` was passed).
    pub fn is_structured(&self) -> bool {
        self.format != Format::Text
    }

    /// Serializes `value` to stdout under the current structured format.
    fn write_structured(&self, value: &impl serde::Serialize) {
        if let Some(rendered) = render_structured(self.format, value) {
            println!("{rendered}");
        }
    }

    /// Prints a human-readable line by default, and the serialized `value`
    /// under `--json`/`--toon`.
    pub fn line(&self, human: impl std::fmt::Display, value: &impl serde::Serialize) {
        if self.is_structured() {
            self.write_structured(value);
        } else {
            println!("{human}");
        }
    }

    /// Prints a list: a `comfy-table` of `rows` by default, or a structured
    /// array under `--json`/`--toon`. `headers` is the column labels. `row`
    /// extracts a tuple of cells per item for the table; each cell is
    /// stringified as-is.
    pub fn list<T, S, const N: usize>(
        &self,
        headers: [&str; N],
        items: &[T],
        row: impl Fn(&T) -> [S; N],
        value: &impl serde::Serialize,
    ) where
        S: std::string::ToString,
    {
        if self.is_structured() {
            self.write_structured(value);
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

/// Renders `value` under `format`, without the trailing newline `println!`
/// adds. `Format::Text` has no structured rendering and returns `None`.
/// Falls back to JSON if TOON encoding fails (e.g. unsupported shapes).
fn render_structured(format: Format, value: &impl serde::Serialize) -> Option<String> {
    match format {
        Format::Json => Some(serde_json::to_string(value).unwrap_or_default()),
        Format::Toon => {
            let json = serde_json::to_value(value).ok()?;
            Some(
                toon_format::encode_default(&json)
                    .unwrap_or_else(|_| serde_json::to_string(value).unwrap_or_default()),
            )
        }
        Format::Text => None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_format_renders_nothing() {
        assert_eq!(
            render_structured(Format::Text, &serde_json::json!({"a": 1})),
            None
        );
    }

    #[test]
    fn json_format_renders_compact_json() {
        let rendered =
            render_structured(Format::Json, &serde_json::json!({"a": 1})).expect("json renders");
        assert_eq!(rendered, r#"{"a":1}"#);
    }

    #[test]
    fn toon_format_renders_tabular_array() {
        let value = serde_json::json!([
            {"id": "abc", "title": "one"},
            {"id": "def", "title": "two"},
        ]);
        let rendered = render_structured(Format::Toon, &value).expect("toon renders");
        // TOON's tabular form: a header row of fields, then one row per item.
        assert!(rendered.contains("id,title"), "got: {rendered}");
        assert!(rendered.contains("abc,one"), "got: {rendered}");
        assert!(rendered.contains("def,two"), "got: {rendered}");
        // Decoding back should round-trip to equivalent JSON.
        let decoded: serde_json::Value =
            toon_format::decode_default(&rendered).expect("toon decodes");
        assert_eq!(decoded, value);
    }

    #[test]
    fn toon_format_renders_scalar_object() {
        let value = serde_json::json!({"id": "abc", "renamed": true});
        let rendered = render_structured(Format::Toon, &value).expect("toon renders");
        let decoded: serde_json::Value =
            toon_format::decode_default(&rendered).expect("toon decodes");
        assert_eq!(decoded, value);
    }
}
