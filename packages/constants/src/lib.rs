//! Shared application constants for Pragma.
//!
//! The Rust types are generated at compile time from `schema.json` and the
//! values are loaded from `values.json` — the very same files the TypeScript
//! frontend consumes. This keeps the frontend and the Tauri backend in lockstep
//! from a single source of truth. Edit `values.json`; never edit generated code.

use std::sync::LazyLock;

mod generated {
    // typify-generated code is not held to our hand-written lint standards.
    #![allow(clippy::all, clippy::pedantic)]
    typify::import_types!("schema.json");
}

pub use generated::{
    AgentAttentionKind, AgentReportKind, AgentReportPayload, AgentStatus, AppInfo,
    BranchSyncStatus, ChangeStatus, ChangedFile, Constants, Daemon, DiffSide, DirEntry,
    EditorLauncher, EditorLaunchers, FileContents, FileDiff, GitHub, GitHubAuthStatus,
    GitHubRepoRef, GitHubUser, KeybindingChord, KeybindingChordModifiersItem, Keybindings,
    KeybindingsConfig, Links, PlatformChord, Project, ProjectIcon, Tab, TabKind, WindowDefaults,
    Worktree, WorktreeChanges, WorktreeStatus,
};

/// The parsed, shared constants.
///
/// Parsed once on first access. Panics at startup if `values.json` ever drifts
/// out of sync with `schema.json` — a bug we want to surface loudly and early.
pub static CONSTANTS: LazyLock<Constants> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../values.json"))
        .expect("values.json must be valid against schema.json")
});

#[cfg(test)]
mod tests {
    use super::CONSTANTS;

    #[test]
    fn app_name_is_present() {
        assert!(!CONSTANTS.app.name.is_empty());
    }

    #[test]
    fn window_defaults_respect_minimums() {
        assert!(CONSTANTS.window.default_width >= CONSTANTS.window.min_width);
        assert!(CONSTANTS.window.default_height >= CONSTANTS.window.min_height);
    }

    #[test]
    fn max_parallel_agents_is_positive() {
        // Same value the frontend reads as `constants.maxParallelAgents`.
        // `minimum: 1` in the schema makes typify generate a `NonZeroU64`, so the
        // Rust side is statically guaranteed non-zero; `.get()` reads the value.
        assert!(CONSTANTS.max_parallel_agents.get() >= 1);
    }

    #[test]
    fn default_editor_launcher_exists() {
        assert!(CONSTANTS.editor_launchers.options.iter().any(|editor| {
            editor.id.as_str() == CONSTANTS.editor_launchers.default_editor_id.as_str()
        }));
    }
}
