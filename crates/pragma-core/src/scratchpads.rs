//! Host-side listing of managed scratchpad files behind the `scratchpads` RPC.
//!
//! A scratchpad is an MDX file under the worktree's scratchpad directory whose
//! YAML frontmatter carries one managed JSON line. Parsing lives here — not in a
//! client — so the desktop, the gateway, and every SDK consumer read the same
//! contract from the host that owns the files. Requests carry the trusted
//! absolute worktree root, exactly as `filesystem` requests do.

use pragma_constants::{ScratchpadFile, CONSTANTS};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fs;
use crate::{CoreError, CoreResult};

/// One scratchpad operation request. `root` is the trusted absolute worktree root.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ScratchpadsRequest {
    /// Lists every managed scratchpad in the worktree, source included.
    List { root: String },
}

/// Managed metadata stored as one JSON line in scratchpad frontmatter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScratchpadMetadata {
    version: u32,
    id: String,
    title: String,
    #[serde(default)]
    agent_tab_id: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    created_at: f64,
}

/// Handles one `scratchpads` RPC payload.
pub fn handle(payload: Value) -> CoreResult<Value> {
    let request: ScratchpadsRequest = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
    match request {
        ScratchpadsRequest::List { root } => serde_json::to_value(list(&root)?)
            .map_err(|error| CoreError::Operation(error.to_string())),
    }
}

/// Lists every managed scratchpad file in a worktree's scratchpad directory,
/// including ones whose tab was closed after creation. Files without managed
/// frontmatter — a hand-dropped MDX file — are skipped, not reported as errors.
pub fn list(root: &str) -> CoreResult<Vec<ScratchpadFile>> {
    let directory = &CONSTANTS.scratchpads.directory;
    let names = fs::list_file_names(
        root,
        directory,
        std::slice::from_ref(&CONSTANTS.scratchpads.extension),
    )?;
    let mut files = Vec::with_capacity(names.len());
    for name in names {
        let file_path = format!("{directory}/{name}");
        let contents = fs::read_file(root, &file_path)?;
        if contents.binary || contents.truncated {
            continue;
        }
        let Some(metadata) = parse_frontmatter(&contents.text) else {
            continue;
        };
        files.push(ScratchpadFile {
            id: metadata.id,
            title: metadata.title,
            file_path,
            contents: contents.text,
            agent_tab_id: metadata.agent_tab_id,
            agent_id: metadata.agent_id,
            created_at: metadata.created_at,
        });
    }
    Ok(files)
}

/// Reads the managed metadata line, rejecting unsupported contract versions.
fn parse_frontmatter(source: &str) -> Option<ScratchpadMetadata> {
    let prefix = format!("{}: ", CONSTANTS.scratchpads.frontmatter_key);
    let json = source.lines().find_map(|line| line.strip_prefix(&prefix))?;
    let metadata: ScratchpadMetadata = serde_json::from_str(json).ok()?;
    (u64::from(metadata.version) == CONSTANTS.scratchpads.version.get()).then_some(metadata)
}

#[cfg(test)]
mod tests {
    use pragma_constants::CONSTANTS;

    use super::{list, parse_frontmatter};

    fn scratchpad(id: &str, extra: &str) -> String {
        format!(
            "---\n{}: {{\"version\":{},\"id\":\"{id}\",\"title\":\"Plan {id}\"{extra}}}\n---\n\n# Plan\n",
            CONSTANTS.scratchpads.frontmatter_key, CONSTANTS.scratchpads.version,
        )
    }

    #[test]
    fn parses_attached_agent_metadata() {
        let parsed = parse_frontmatter(&scratchpad(
            "abc",
            ",\"agentTabId\":\"tab-1\",\"agentId\":\"claude\",\"createdAt\":42",
        ))
        .expect("managed frontmatter should parse");
        assert_eq!(parsed.id, "abc");
        assert_eq!(parsed.agent_tab_id.as_deref(), Some("tab-1"));
        assert_eq!(parsed.agent_id.as_deref(), Some("claude"));
    }

    #[test]
    fn rejects_unsupported_version() {
        let source = format!(
            "---\n{}: {{\"version\":999,\"id\":\"a\",\"title\":\"t\"}}\n---\n",
            CONSTANTS.scratchpads.frontmatter_key,
        );
        assert!(parse_frontmatter(&source).is_none());
    }

    #[test]
    fn lists_managed_files_and_skips_unmanaged_ones() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let root = temporary.path();
        let directory = root.join(&CONSTANTS.scratchpads.directory);
        std::fs::create_dir_all(&directory).expect("scratchpad dir");
        std::fs::write(
            directory.join("plan.mdx"),
            scratchpad("abc", ",\"agentTabId\":\"tab-1\",\"agentId\":\"claude\""),
        )
        .expect("write managed");
        std::fs::write(directory.join("notes.mdx"), "# just markdown\n").expect("write unmanaged");

        let files = list(&root.to_string_lossy()).expect("list should succeed");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "abc");
        assert_eq!(files[0].agent_id.as_deref(), Some("claude"));
        assert!(files[0].contents.contains("# Plan"));
    }

    #[test]
    fn missing_directory_lists_nothing() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let files = list(&temporary.path().to_string_lossy()).expect("list should succeed");
        assert!(files.is_empty());
    }
}
