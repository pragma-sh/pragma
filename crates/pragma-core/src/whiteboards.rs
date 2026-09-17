//! Durable, worktree-scoped Excalidraw documents behind the `whiteboards` RPC.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use chrono::Utc;
use excalidraw_image::argv::Args as RenderArgs;
use excalidraw_image::engine::Engine;
use excalidraw_image::raster::{svg_to_png, RasterOptions};
use pragma_constants::{ExcalidrawScene, Whiteboard, WhiteboardViewResult, CONSTANTS};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{CoreError, CoreResult};

/// One whiteboard operation served by the host owning its worktree.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WhiteboardsRequest {
    /// Creates a whiteboard from a validated Excalidraw scene.
    Create {
        worktree_id: String,
        title: String,
        scene: ExcalidrawScene,
    },
    /// Returns one whiteboard by durable id.
    Get { worktree_id: String, id: String },
    /// Lists a worktree's whiteboards, optionally searching title and element text.
    List {
        worktree_id: String,
        #[serde(default)]
        query: Option<String>,
    },
    /// Replaces one whiteboard after an optimistic version check.
    Edit {
        worktree_id: String,
        id: String,
        title: String,
        scene: ExcalidrawScene,
        expected_version: u64,
    },
    /// Deletes one whiteboard by id.
    Delete { worktree_id: String, id: String },
    /// Renders one whiteboard to a base64-encoded PNG.
    View {
        worktree_id: String,
        id: String,
        #[serde(default)]
        dark: bool,
    },
    /// Deletes all whiteboards scoped to a removed worktree.
    DeleteForWorktree { worktree_id: String },
}

/// SQLite-backed whiteboard store. Connections are short-lived so the store is
/// safe to share across the server's thread-per-client RPC handlers.
pub struct WhiteboardStore {
    database_path: PathBuf,
}

impl WhiteboardStore {
    /// Opens or creates the store under the server's owner-only state directory.
    pub fn new(state_dir: &Path) -> CoreResult<Self> {
        let store = Self {
            database_path: state_dir.join(&CONSTANTS.whiteboards.database_file),
        };
        store.connection()?;
        Ok(store)
    }

    /// Handles one whiteboard RPC payload.
    pub fn handle(&self, payload: Value) -> CoreResult<Value> {
        let request: WhiteboardsRequest = serde_json::from_value(payload)
            .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
        let value = match request {
            WhiteboardsRequest::Create {
                worktree_id,
                title,
                scene,
            } => serde_json::to_value(self.create(&worktree_id, &title, &scene)?),
            WhiteboardsRequest::Get { worktree_id, id } => {
                serde_json::to_value(self.get(&worktree_id, &id)?)
            }
            WhiteboardsRequest::List { worktree_id, query } => {
                serde_json::to_value(self.list(&worktree_id, query.as_deref())?)
            }
            WhiteboardsRequest::Edit {
                worktree_id,
                id,
                title,
                scene,
                expected_version,
            } => serde_json::to_value(self.edit(
                &worktree_id,
                &id,
                &title,
                &scene,
                expected_version,
            )?),
            WhiteboardsRequest::Delete { worktree_id, id } => {
                self.delete(&worktree_id, &id)?;
                serde_json::to_value(())
            }
            WhiteboardsRequest::View {
                worktree_id,
                id,
                dark,
            } => serde_json::to_value(self.view(&worktree_id, &id, dark)?),
            WhiteboardsRequest::DeleteForWorktree { worktree_id } => {
                serde_json::to_value(self.delete_for_worktree(&worktree_id)?)
            }
        };
        value.map_err(|error| CoreError::Operation(error.to_string()))
    }

    fn connection(&self) -> CoreResult<Connection> {
        let connection = Connection::open(&self.database_path).map_err(operation)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(operation)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS whiteboards (
                   id TEXT PRIMARY KEY,
                   worktree_id TEXT NOT NULL,
                   title TEXT NOT NULL,
                   scene TEXT NOT NULL,
                   search_text TEXT NOT NULL,
                   version INTEGER NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS whiteboards_worktree_updated
                   ON whiteboards(worktree_id, updated_at DESC);",
            )
            .map_err(operation)?;
        Ok(connection)
    }

    fn create(
        &self,
        worktree_id: &str,
        title: &str,
        scene: &ExcalidrawScene,
    ) -> CoreResult<Whiteboard> {
        validate_worktree_id(worktree_id)?;
        let title = validate_title(title)?;
        let scene_json = validate_scene(scene)?;
        let now = now_millis()?;
        let id = Uuid::new_v4().to_string();
        self.connection()?
            .execute(
                "INSERT INTO whiteboards
                 (id, worktree_id, title, scene, search_text, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
                params![
                    id,
                    worktree_id,
                    title,
                    scene_json,
                    search_text(title, scene),
                    now
                ],
            )
            .map_err(operation)?;
        self.get(worktree_id, &id)
    }

    fn get(&self, worktree_id: &str, id: &str) -> CoreResult<Whiteboard> {
        validate_worktree_id(worktree_id)?;
        validate_id(id)?;
        self.connection()?
            .query_row(
                "SELECT id, worktree_id, title, scene, version, created_at, updated_at
                 FROM whiteboards WHERE worktree_id = ?1 AND id = ?2",
                params![worktree_id, id],
                whiteboard_from_row,
            )
            .optional()
            .map_err(operation)?
            .ok_or_else(|| CoreError::NotFound(format!("whiteboard {id}")))
    }

    fn list(&self, worktree_id: &str, query: Option<&str>) -> CoreResult<Vec<Whiteboard>> {
        validate_worktree_id(worktree_id)?;
        let connection = self.connection()?;
        let query = query.map(str::trim).filter(|query| !query.is_empty());
        let mut boards = Vec::new();
        if let Some(query) = query {
            let pattern = format!("%{}%", escape_like_pattern(&query.to_lowercase()));
            let mut statement = connection
                .prepare(
                    "SELECT id, worktree_id, title, scene, version, created_at, updated_at
                     FROM whiteboards
                     WHERE worktree_id = ?1
                        AND search_text LIKE ?2 ESCAPE '!'
                     ORDER BY updated_at DESC, id ASC",
                )
                .map_err(operation)?;
            let rows = statement
                .query_map(params![worktree_id, pattern], whiteboard_from_row)
                .map_err(operation)?;
            for row in rows {
                boards.push(row.map_err(operation)?);
            }
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT id, worktree_id, title, scene, version, created_at, updated_at
                     FROM whiteboards WHERE worktree_id = ?1
                     ORDER BY updated_at DESC, id ASC",
                )
                .map_err(operation)?;
            let rows = statement
                .query_map([worktree_id], whiteboard_from_row)
                .map_err(operation)?;
            for row in rows {
                boards.push(row.map_err(operation)?);
            }
        }
        Ok(boards)
    }

    fn edit(
        &self,
        worktree_id: &str,
        id: &str,
        title: &str,
        scene: &ExcalidrawScene,
        expected_version: u64,
    ) -> CoreResult<Whiteboard> {
        validate_worktree_id(worktree_id)?;
        validate_id(id)?;
        if expected_version == 0 {
            return Err(CoreError::InvalidPayload(
                "expectedVersion must be at least 1".to_string(),
            ));
        }
        let title = validate_title(title)?;
        let scene_json = validate_scene(scene)?;
        let changed = self
            .connection()?
            .execute(
                "UPDATE whiteboards
                 SET title = ?1, scene = ?2, search_text = ?3,
                     version = version + 1, updated_at = ?4
                  WHERE worktree_id = ?5 AND id = ?6 AND version = ?7",
                params![
                    title,
                    scene_json,
                    search_text(title, scene),
                    now_millis()?,
                    worktree_id,
                    id,
                    expected_version,
                ],
            )
            .map_err(operation)?;
        if changed == 0 {
            return match self.get(worktree_id, id) {
                Ok(_) => Err(CoreError::StaleWrite),
                Err(CoreError::NotFound(_)) => Err(CoreError::NotFound(format!("whiteboard {id}"))),
                Err(error) => Err(error),
            };
        }
        self.get(worktree_id, id)
    }

    fn delete(&self, worktree_id: &str, id: &str) -> CoreResult<()> {
        validate_worktree_id(worktree_id)?;
        validate_id(id)?;
        let changed = self
            .connection()?
            .execute(
                "DELETE FROM whiteboards WHERE worktree_id = ?1 AND id = ?2",
                params![worktree_id, id],
            )
            .map_err(operation)?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("whiteboard {id}")));
        }
        Ok(())
    }

    fn view(&self, worktree_id: &str, id: &str, dark: bool) -> CoreResult<WhiteboardViewResult> {
        let board = self.get(worktree_id, id)?;
        let scene = serde_json::to_string(&board.scene)
            .map_err(|error| CoreError::Operation(error.to_string()))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .map_err(|error| CoreError::Operation(error.to_string()))?;
        let mut engine = Engine::new();
        let render_args = RenderArgs {
            dark,
            ..RenderArgs::default()
        };
        let rendered = runtime
            .block_on(engine.render(&scene, &render_args.opts_json(false)))
            .map_err(|error| CoreError::Operation(format!("render whiteboard: {error}")))?;
        let max = u32::try_from(CONSTANTS.whiteboards.max_render_dimension.get())
            .map_err(|error| CoreError::Operation(error.to_string()))?;
        let png = svg_to_png(
            &rendered.svg,
            &RasterOptions {
                scale: None,
                max: Some(max),
            },
        )
        .map_err(|error| CoreError::Operation(format!("rasterize whiteboard: {error}")))?;
        Ok(WhiteboardViewResult {
            data: base64::engine::general_purpose::STANDARD.encode(png),
        })
    }

    fn delete_for_worktree(&self, worktree_id: &str) -> CoreResult<u64> {
        validate_worktree_id(worktree_id)?;
        let changed = self
            .connection()?
            .execute(
                "DELETE FROM whiteboards WHERE worktree_id = ?1",
                [worktree_id],
            )
            .map_err(operation)?;
        u64::try_from(changed).map_err(|error| CoreError::Operation(error.to_string()))
    }
}

fn validate_id(id: &str) -> CoreResult<()> {
    if id.trim().is_empty() {
        return Err(CoreError::InvalidPayload(
            "id must not be empty".to_string(),
        ));
    }
    Ok(())
}

fn validate_worktree_id(worktree_id: &str) -> CoreResult<()> {
    if worktree_id.trim().is_empty() {
        return Err(CoreError::InvalidPayload(
            "worktreeId must not be empty".to_string(),
        ));
    }
    Ok(())
}

fn validate_title(title: &str) -> CoreResult<&str> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CoreError::InvalidPayload(
            "title must not be empty".to_string(),
        ));
    }
    let max_title_chars =
        usize::try_from(CONSTANTS.whiteboards.max_title_chars.get()).unwrap_or(usize::MAX);
    if title.chars().count() > max_title_chars {
        return Err(CoreError::InvalidPayload(format!(
            "title exceeds {} characters",
            CONSTANTS.whiteboards.max_title_chars
        )));
    }
    Ok(title)
}

fn validate_scene(scene: &ExcalidrawScene) -> CoreResult<String> {
    let object = scene.as_object().ok_or_else(|| {
        CoreError::InvalidPayload("scene must be an Excalidraw object".to_string())
    })?;
    if object.get("type").and_then(Value::as_str) != Some("excalidraw") {
        return Err(CoreError::InvalidPayload(
            "scene.type must be `excalidraw`".to_string(),
        ));
    }
    if object.get("version").and_then(Value::as_u64).unwrap_or(0) == 0 {
        return Err(CoreError::InvalidPayload(
            "scene.version must be at least 1".to_string(),
        ));
    }
    let elements = object
        .get("elements")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidPayload("scene.elements must be an array".to_string()))?;
    if elements.iter().any(|element| {
        element.get("id").and_then(Value::as_str).is_none()
            || element.get("type").and_then(Value::as_str).is_none()
    }) {
        return Err(CoreError::InvalidPayload(
            "every scene element requires string id and type fields".to_string(),
        ));
    }
    for field in ["appState", "files"] {
        if !object.get(field).is_some_and(Value::is_object) {
            return Err(CoreError::InvalidPayload(format!(
                "scene.{field} must be an object"
            )));
        }
    }
    let scene = serde_json::to_string(scene)
        .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
    let max_scene_bytes =
        usize::try_from(CONSTANTS.whiteboards.max_scene_bytes.get()).unwrap_or(usize::MAX);
    if scene.len() > max_scene_bytes {
        return Err(CoreError::InvalidPayload(format!(
            "scene exceeds {} bytes",
            CONSTANTS.whiteboards.max_scene_bytes
        )));
    }
    Ok(scene)
}

fn search_text(title: &str, scene: &ExcalidrawScene) -> String {
    let Ok(Value::Object(scene)) = serde_json::to_value(scene) else {
        return title.to_lowercase();
    };
    let element_text = scene
        .get("elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|element| [element.get("text"), element.get("originalText")])
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    format!("{title}\n{element_text}").to_lowercase()
}

fn escape_like_pattern(query: &str) -> String {
    query
        .replace('!', "!!")
        .replace('%', "!%")
        .replace('_', "!_")
}

fn whiteboard_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Whiteboard> {
    let scene_json: String = row.get(3)?;
    let scene = serde_json::from_str(&scene_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            scene_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(Whiteboard {
        id: row.get(0)?,
        worktree_id: row.get(1)?,
        title: row.get(2)?,
        scene,
        version: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn now_millis() -> CoreResult<u64> {
    u64::try_from(Utc::now().timestamp_millis())
        .map_err(|error| CoreError::Operation(error.to_string()))
}

fn operation(error: rusqlite::Error) -> CoreError {
    let message = error.to_string();
    drop(error);
    CoreError::Operation(message)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde_json::json;

    use super::WhiteboardStore;
    use crate::CoreError;

    fn scene(text: &str) -> pragma_constants::ExcalidrawScene {
        serde_json::from_value(json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [{ "id": "text-1", "type": "text", "text": text }],
            "appState": {},
            "files": {}
        }))
        .expect("valid scene")
    }

    #[test]
    fn creates_searches_edits_and_deletes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = WhiteboardStore::new(directory.path()).expect("store");
        let created = store
            .create("wt-1", "Auth flow", &scene("refresh token"))
            .expect("create");
        assert_eq!(store.list("wt-1", Some("token")).expect("search").len(), 1);
        let edited = store
            .edit(
                "wt-1",
                &created.id,
                "Login flow",
                &scene("session"),
                created.version.get(),
            )
            .expect("edit");
        assert_eq!(edited.version.get(), 2);
        assert!(matches!(
            store.edit(
                "wt-1",
                &created.id,
                "stale",
                &scene("x"),
                created.version.get()
            ),
            Err(CoreError::StaleWrite)
        ));
        store.delete("wt-1", &created.id).expect("delete");
        assert!(matches!(
            store.get("wt-1", &created.id),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn accepts_camel_case_wire_fields() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = WhiteboardStore::new(directory.path()).expect("store");
        let created = store
            .handle(json!({
                "action": "create",
                "worktreeId": "wt-1",
                "title": "Wire contract",
                "scene": scene("camel case")
            }))
            .expect("create through wire shape");
        assert_eq!(created["worktreeId"], "wt-1");
    }

    #[test]
    fn deletes_every_board_for_a_worktree() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = WhiteboardStore::new(directory.path()).expect("store");
        store.create("wt-1", "One", &scene("one")).expect("create");
        store.create("wt-1", "Two", &scene("two")).expect("create");
        store
            .create("wt-2", "Other", &scene("other"))
            .expect("create");
        assert_eq!(store.delete_for_worktree("wt-1").expect("delete"), 2);
        assert!(store.list("wt-1", None).expect("list").is_empty());
        assert_eq!(store.list("wt-2", None).expect("list").len(), 1);
    }

    #[test]
    fn id_operations_are_scoped_to_the_requested_worktree() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = WhiteboardStore::new(directory.path()).expect("store");
        let board = store
            .create("wt-1", "Private", &scene("one"))
            .expect("create");

        assert!(matches!(
            store.get("wt-2", &board.id),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            store.edit(
                "wt-2",
                &board.id,
                "Changed",
                &scene("two"),
                board.version.get()
            ),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            store.delete("wt-2", &board.id),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            store.view("wt-2", &board.id, false),
            Err(CoreError::NotFound(_))
        ));
        assert_eq!(
            store.get("wt-1", &board.id).expect("original board").title,
            "Private"
        );
    }

    #[test]
    fn search_treats_like_metacharacters_as_text() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = WhiteboardStore::new(directory.path()).expect("store");
        store
            .create("wt-1", "100% Complete", &scene("under_score"))
            .expect("create");
        store
            .create("wt-1", "Other", &scene("plain"))
            .expect("create");

        assert_eq!(store.list("wt-1", Some("%")).expect("search").len(), 1);
        assert_eq!(store.list("wt-1", Some("_")).expect("search").len(), 1);
    }

    #[test]
    fn renders_png() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = WhiteboardStore::new(directory.path()).expect("store");
        let board = store
            .create(
                "wt-1",
                "Rectangle",
                &serde_json::from_value(json!({
                    "type": "excalidraw",
                    "version": 2,
                    "source": "pragma",
                    "elements": [{
                        "id": "rectangle-1",
                        "type": "rectangle",
                        "x": 0,
                        "y": 0,
                        "width": 100,
                        "height": 50,
                        "angle": 0,
                        "strokeColor": "#000000",
                        "backgroundColor": "transparent",
                        "fillStyle": "solid",
                        "strokeWidth": 1,
                        "strokeStyle": "solid",
                        "roughness": 1,
                        "opacity": 100,
                        "groupIds": [],
                        "frameId": null,
                        "roundness": null,
                        "seed": 1,
                        "version": 1,
                        "versionNonce": 1,
                        "isDeleted": false,
                        "boundElements": null,
                        "updated": 0,
                        "link": null,
                        "locked": false
                    }],
                    "appState": { "viewBackgroundColor": "#ffffff" },
                    "files": {}
                }))
                .expect("valid scene"),
            )
            .expect("create");
        let rendered = store.view("wt-1", &board.id, false).expect("render");
        let dark_rendered = store.view("wt-1", &board.id, true).expect("dark render");
        let png = base64::engine::general_purpose::STANDARD
            .decode(&rendered.data)
            .expect("base64");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_ne!(rendered.data, dark_rendered.data);
    }

    #[test]
    fn renders_empty_board_png() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = WhiteboardStore::new(directory.path()).expect("store");
        let board = store
            .create(
                "wt-1",
                "Empty",
                &serde_json::from_value(json!({
                    "type": "excalidraw",
                    "version": 2,
                    "source": "pragma",
                    "elements": [],
                    "appState": { "viewBackgroundColor": "#ffffff" },
                    "files": {}
                }))
                .expect("valid scene"),
            )
            .expect("create");
        let rendered = store.view("wt-1", &board.id, false).expect("render");
        let png = base64::engine::general_purpose::STANDARD
            .decode(rendered.data)
            .expect("base64");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
