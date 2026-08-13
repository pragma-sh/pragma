use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use pragma_constants::CONSTANTS;
use serde::Deserialize;

use crate::error::{GatewayError, GatewayResult};

// The staged Pragma Go web bundle, read once at startup into a lookup table.
//
// The table is the security boundary. A request path is used as a **map key**
// and never joined onto a filesystem path, so there is no traversal surface to
// get wrong — the same property `routes::assets` gets from serving by content
// hash. Anything the staging script did not list is simply not servable.
//
// Bodies are not held in memory: each entry keeps the file's path and is
// streamed from disk per request, so a 6 MB bundle costs the gateway a few
// kilobytes of map, not the bundle.

/// One servable file, as named by the staged manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebAsset {
    /// URL path relative to the bundle's base path, e.g. `_expo/static/js/x.js`.
    pub path: String,
    /// File name on disk inside the bundle directory.
    pub file: String,
    /// Value for the `content-type` header.
    pub content_type: String,
    /// Set when `file` holds gzip-compressed bytes.
    #[serde(default)]
    pub gzip: bool,
    /// Strong `ETag` value: the content hash of the *uncompressed* bytes.
    pub etag: String,
    /// Whether the file name contains a content hash and can be cached forever.
    #[serde(default)]
    pub immutable: bool,
}

/// The staged bundle's manifest, as written by `scripts/stage-web-bundle.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebManifest {
    /// URL prefix the bundle was exported for; must match this build's.
    base_path: String,
    /// Every servable file.
    assets: Vec<WebAsset>,
}

/// The loaded bundle: a lookup table plus the directory its files live in.
#[derive(Debug, Clone)]
pub struct WebBundle {
    root: PathBuf,
    assets: HashMap<String, WebAsset>,
    index: WebAsset,
}

impl WebBundle {
    /// Reads the manifest in `root` and builds the lookup table.
    ///
    /// Fails rather than serving a partial app: a bundle whose manifest is
    /// missing, malformed, exported for a different base path, or missing its
    /// entry point would fail later as a blank page with no explanation.
    pub fn load(root: &Path) -> GatewayResult<Self> {
        let manifest_path = root.join(CONSTANTS.gateway.web.manifest_file.as_str());
        let raw = fs::read_to_string(&manifest_path).map_err(|error| {
            GatewayError::Server(format!(
                "could not read the web bundle manifest at {}: {error}",
                manifest_path.display()
            ))
        })?;
        let manifest: WebManifest = serde_json::from_str(&raw)?;
        if manifest.base_path != CONSTANTS.gateway.web.base_path.as_str() {
            return Err(GatewayError::Server(format!(
                "web bundle was exported for base path {} but this gateway serves {}",
                manifest.base_path,
                CONSTANTS.gateway.web.base_path.as_str(),
            )));
        }

        let assets: HashMap<String, WebAsset> = manifest
            .assets
            .into_iter()
            .map(|asset| (asset.path.clone(), asset))
            .collect();
        let index = assets
            .get(INDEX_PATH)
            .ok_or_else(|| {
                GatewayError::Server(format!("web bundle manifest has no {INDEX_PATH}"))
            })?
            .clone();
        Ok(Self {
            root: root.to_path_buf(),
            assets,
            index,
        })
    }

    /// Resolves one request path to the asset that should answer it.
    ///
    /// An unknown path is *not* a 404: the bundle is a single-page app, so any
    /// path it does not have a file for is a client-side route and the entry
    /// point must answer it so the router can take over. Only paths that look
    /// like files are allowed to miss, so a mistyped asset URL still fails
    /// loudly instead of returning HTML that the browser cannot parse as JS.
    #[must_use]
    pub fn resolve(&self, path: &str) -> Option<&WebAsset> {
        let trimmed = path.trim_start_matches('/');
        if trimmed.is_empty() {
            return Some(&self.index);
        }
        if let Some(asset) = self.assets.get(trimmed) {
            return Some(asset);
        }
        if looks_like_file(trimmed) {
            return None;
        }
        Some(&self.index)
    }

    /// Absolute path of an asset's bytes on disk.
    #[must_use]
    pub fn file_path(&self, asset: &WebAsset) -> PathBuf {
        self.root.join(&asset.file)
    }
}

/// The bundle's entry point, and the fallback for client-side routes.
const INDEX_PATH: &str = "index.html";

/// Whether a path's last segment carries a file extension.
///
/// Client routes are `/worktree/wt-123`; assets are `/_expo/…/entry-abc.js`. A
/// dot in the final segment is the practical difference between the two.
fn looks_like_file(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{looks_like_file, WebBundle};

    fn write_bundle(dir: &std::path::Path, base_path: &str) {
        fs::write(dir.join("index.html"), "<!doctype html>").expect("index");
        fs::write(dir.join("app.js"), "console.log(1)").expect("asset");
        let manifest = format!(
            r#"{{"basePath":"{base_path}","assets":[
                {{"path":"index.html","file":"index.html","contentType":"text/html","etag":"a","immutable":false}},
                {{"path":"_expo/app.js","file":"app.js","contentType":"text/javascript","etag":"b","immutable":true}}
            ]}}"#
        );
        fs::write(dir.join("manifest.json"), manifest).expect("manifest");
    }

    #[test]
    fn serves_listed_assets_and_falls_back_to_index() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_bundle(dir.path(), "/web");
        let bundle = WebBundle::load(dir.path()).expect("bundle");

        assert_eq!(bundle.resolve("_expo/app.js").expect("asset").etag, "b");
        // Bare base path, and a client-side route, both answer with the entry point.
        assert_eq!(bundle.resolve("").expect("index").etag, "a");
        assert_eq!(bundle.resolve("worktree/wt-1").expect("index").etag, "a");
    }

    #[test]
    fn unknown_file_paths_still_miss() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_bundle(dir.path(), "/web");
        let bundle = WebBundle::load(dir.path()).expect("bundle");
        assert!(bundle.resolve("_expo/missing.js").is_none());
    }

    #[test]
    fn traversal_is_not_expressible() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_bundle(dir.path(), "/web");
        let bundle = WebBundle::load(dir.path()).expect("bundle");
        // Not a listed key, and it has an extension, so it misses outright —
        // the path is never touched by the filesystem.
        assert!(bundle.resolve("../../etc/passwd.txt").is_none());
        // Without an extension it falls back to the entry point, which is still
        // the bundle's own file rather than anything the path names.
        assert_eq!(bundle.resolve("../../etc/passwd").expect("index").etag, "a");
    }

    #[test]
    fn rejects_a_bundle_exported_for_another_base_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_bundle(dir.path(), "/elsewhere");
        assert!(WebBundle::load(dir.path()).is_err());
    }

    #[test]
    fn file_paths_are_told_apart_from_client_routes() {
        assert!(looks_like_file("_expo/static/js/entry-abc.js"));
        assert!(looks_like_file("favicon.ico"));
        assert!(!looks_like_file("worktree/wt-1"));
        assert!(!looks_like_file("project/proj.with.dots/worktrees"));
    }
}
