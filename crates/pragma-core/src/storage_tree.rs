//! The per-folder totals a storage scan returns for the treemap.
//!
//! The treemap draws the top-level folders of a worktree as whole boxes, so the
//! walk only has to know which top-level entry each file sits under: every file
//! is charged to its top-level folder, and files directly in the root share one
//! `files` entry. Which of these the map draws (folders of 15 MB or more) is
//! the client's call; the host reports them all.

use pragma_constants::{StorageTreeEntry, StorageTreeEntryKind};

/// Running total for one top-level entry.
struct Tally {
    name: String,
    bytes: u64,
    files: u64,
}

/// Top-level folder totals accumulated during a walk.
pub(crate) struct TopLevel {
    folders: Vec<Tally>,
    root_files: Tally,
}

impl TopLevel {
    pub(crate) fn new() -> Self {
        Self {
            folders: Vec::new(),
            root_files: Tally {
                name: String::new(),
                bytes: 0,
                files: 0,
            },
        }
    }

    /// Registers a folder directly under the root and returns its index.
    pub(crate) fn add_folder(&mut self, name: String) -> usize {
        self.folders.push(Tally {
            name,
            bytes: 0,
            files: 0,
        });
        self.folders.len() - 1
    }

    /// Charges one file of `bytes` to top-level folder `folder`, or to the
    /// root's own files when `None`.
    pub(crate) fn add_file(&mut self, folder: Option<usize>, bytes: u64) {
        let tally = match folder {
            Some(index) => &mut self.folders[index],
            None => &mut self.root_files,
        };
        tally.bytes = tally.bytes.saturating_add(bytes);
        tally.files += 1;
    }

    /// One entry per non-empty top-level folder, plus one for the root's files.
    pub(crate) fn finish(self) -> Vec<StorageTreeEntry> {
        let entry = |tally: Tally, kind| StorageTreeEntry {
            name: tally.name,
            bytes: tally.bytes,
            file_count: tally.files,
            kind,
            children: Vec::new(),
        };
        let mut entries: Vec<StorageTreeEntry> = self
            .folders
            .into_iter()
            .filter(|folder| folder.bytes > 0)
            .map(|folder| entry(folder, StorageTreeEntryKind::Folder))
            .collect();
        if self.root_files.bytes > 0 {
            entries.push(entry(self.root_files, StorageTreeEntryKind::Files));
        }
        entries
    }
}

#[cfg(test)]
mod tests {
    use pragma_constants::StorageTreeEntryKind;

    use super::TopLevel;

    #[test]
    fn totals_each_top_level_folder_and_the_root_files() {
        let mut top = TopLevel::new();
        let src = top.add_folder("src".to_string());
        top.add_folder("empty".to_string());
        top.add_file(Some(src), 100);
        top.add_file(Some(src), 50);
        top.add_file(None, 7);

        let entries = top.finish();
        // The empty folder has nothing to draw.
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[0].bytes, 150);
        assert_eq!(entries[0].file_count, 2);
        assert!(entries[0].children.is_empty());
        assert_eq!(entries[1].kind, StorageTreeEntryKind::Files);
        assert_eq!(entries[1].bytes, 7);
    }
}
