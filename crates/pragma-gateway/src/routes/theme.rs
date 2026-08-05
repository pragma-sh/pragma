//! `GET /v1/theme` — the user's `.pragma/theme.json` color overrides, merged
//! across scopes so a remote client can mirror the desktop's theme.
//!
//! The desktop layers theme files per token as `index.css` defaults <- global
//! (`~/.pragma/theme.json`) <- project (`<root>/.pragma/theme.json`). Only the
//! two user layers cross the wire: the shipped defaults belong to whichever app
//! renders them, and a native client's are not the desktop's CSS. A client
//! therefore applies what it receives on top of its own defaults.
//!
//! Token names are passed through untouched. The catalog of valid tokens is
//! derived from `apps/pragma/src/index.css` and is deliberately not shared with
//! Rust, so filtering happens on the client that knows its own token set.

use std::collections::BTreeMap;
use std::path::Path;

use pragma_constants::CONSTANTS;
use serde::Serialize;
use serde_json::Value;
use tiny_http::Response;

use crate::error::{GatewayError, GatewayResult};
use crate::http::response::json_response;
use crate::http::router::RouteMatch;
use crate::http::AppState;

/// Overrides for one color scheme, keyed by token name (no `--` prefix).
type ThemeOverrides = BTreeMap<String, String>;

/// Which scopes contributed to the merged result, so a client can tell "no
/// theme file" from "a theme file that overrides nothing".
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ThemeSources {
    global: bool,
    project: bool,
}

/// Body of `GET /v1/theme`.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ThemeResponse {
    /// Merged overrides keyed by color scheme (`light`, `dark`).
    colors: BTreeMap<String, ThemeOverrides>,
    sources: ThemeSources,
}

/// Handles `GET /v1/theme`, optionally scoped to a project with
/// `?root=<absolute project root>`.
///
/// A missing or unreadable theme file is not an error — it means "no
/// overrides", which is the common case.
pub fn get(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<Response<std::io::Cursor<Vec<u8>>>> {
    let relative = CONSTANTS.theme.file_name.as_str();
    let home = pragma_platform::path::home_dir()
        .ok_or_else(|| GatewayError::Server("could not resolve the home directory".to_string()))?;
    let global = read_theme_file(state, &home.to_string_lossy(), relative)?;
    let project = match matched.query.get("root") {
        Some(root) => {
            if !Path::new(root).is_absolute() {
                return Err(GatewayError::InvalidPayload(
                    "root must be an absolute path".to_string(),
                ));
            }
            read_theme_file(state, root, relative)?
        }
        None => None,
    };
    json_response(200, &merge_themes(global.as_ref(), project.as_ref()))
}

/// Reads and parses one scope's theme file, treating an absent file as `None`.
fn read_theme_file(state: &AppState, root: &str, relative: &str) -> GatewayResult<Option<Value>> {
    let Some(contents) = state.client.read_text_file(root, relative)? else {
        return Ok(None);
    };
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|error| GatewayError::InvalidPayload(format!("{relative}: {error}")))?;
    if !value.is_object() {
        return Err(GatewayError::InvalidPayload(format!(
            "{relative} root must be an object"
        )));
    }
    Ok(Some(value))
}

/// Layers two theme files per token, later winning, for every declared mode.
fn merge_themes(global: Option<&Value>, project: Option<&Value>) -> ThemeResponse {
    let mut colors = BTreeMap::new();
    for mode in &CONSTANTS.theme.modes {
        let mode = serde_json::to_value(mode)
            .ok()
            .and_then(|value| value.as_str().map(ToString::to_string));
        let Some(mode) = mode else { continue };
        let mut overrides = ThemeOverrides::new();
        for layer in [global, project].into_iter().flatten() {
            overrides.extend(mode_overrides(layer, &mode));
        }
        if !overrides.is_empty() {
            colors.insert(mode, overrides);
        }
    }
    ThemeResponse {
        colors,
        sources: ThemeSources {
            global: global.is_some(),
            project: project.is_some(),
        },
    }
}

/// Extracts `colors.<mode>` string entries; anything else in the file is
/// ignored rather than rejected, so a theme written by a newer Pragma still
/// serves the tokens this one understands.
fn mode_overrides(file: &Value, mode: &str) -> ThemeOverrides {
    file.get("colors")
        .and_then(|colors| colors.get(mode))
        .and_then(Value::as_object)
        .map(|block| {
            block
                .iter()
                .filter_map(|(token, value)| {
                    value
                        .as_str()
                        .map(|color| (token.clone(), color.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{merge_themes, ThemeSources};

    #[test]
    fn project_tokens_win_over_global_ones() {
        let global = json!({ "colors": { "dark": { "background": "oklch(0.2 0 0)", "border": "oklch(0.3 0 0)" } } });
        let project = json!({ "colors": { "dark": { "background": "oklch(0.1 0 0)" } } });

        let merged = merge_themes(Some(&global), Some(&project));

        let dark = merged.colors.get("dark").expect("dark overrides");
        assert_eq!(
            dark.get("background").map(String::as_str),
            Some("oklch(0.1 0 0)")
        );
        assert_eq!(
            dark.get("border").map(String::as_str),
            Some("oklch(0.3 0 0)")
        );
        assert_eq!(
            merged.sources,
            ThemeSources {
                global: true,
                project: true
            }
        );
    }

    #[test]
    fn a_missing_theme_file_yields_no_overrides() {
        let merged = merge_themes(None, None);
        assert!(merged.colors.is_empty());
        assert_eq!(merged.sources, ThemeSources::default());
    }

    #[test]
    fn non_string_and_unknown_shapes_are_ignored() {
        let global = json!({
            "$schema": "https://pragma.sh/theme.json",
            "colors": { "light": { "background": "#fff", "radius": 4 }, "sepia": { "background": "#eee" } }
        });

        let merged = merge_themes(Some(&global), None);

        let light = merged.colors.get("light").expect("light overrides");
        assert_eq!(light.get("background").map(String::as_str), Some("#fff"));
        assert!(!light.contains_key("radius"));
        assert!(!merged.colors.contains_key("sepia"));
    }
}
