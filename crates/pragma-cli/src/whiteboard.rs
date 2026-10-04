//! Direct-to-host whiteboard CRUD and PNG export.

use std::io::{IsTerminal, Write};

use base64::Engine as _;
use pragma_constants::{ExcalidrawScene, ProtocolRpcMethod, Whiteboard, CONSTANTS};
use serde_json::{json, Value};

use crate::cli::{
    WhiteboardCommand, WhiteboardCreateArgs, WhiteboardDeleteArgs, WhiteboardEditArgs,
    WhiteboardIdArgs, WhiteboardListArgs, WhiteboardSearchArgs, WhiteboardViewArgs,
};
use crate::output::Output;
use crate::server::{self, CliError};

/// Runs one whiteboard command against the persistent host.
pub fn run(command: &WhiteboardCommand, out: &Output) -> Result<(), CliError> {
    match command {
        WhiteboardCommand::Create(args) => create(args, out),
        WhiteboardCommand::List(args) => list(args, out),
        WhiteboardCommand::Search(args) => search(args, out),
        WhiteboardCommand::Get(args) => get(args, out),
        WhiteboardCommand::Edit(args) => edit(args, out),
        WhiteboardCommand::Delete(args) => delete(args, out),
        WhiteboardCommand::View(args) => view(args, out),
    }
}

fn create(args: &WhiteboardCreateArgs, out: &Output) -> Result<(), CliError> {
    let scene = read_scene(&args.scene)?;
    let title = args
        .title
        .as_deref()
        .unwrap_or(&CONSTANTS.whiteboards.default_title);
    let board: Whiteboard = parse(rpc(json!({
        "action": "create",
        "worktreeId": server::worktree_id(args.worktree.clone())?,
        "title": title,
        "scene": scene,
    }))?)?;
    render_board(&board, out);
    Ok(())
}

fn list(args: &WhiteboardListArgs, out: &Output) -> Result<(), CliError> {
    render_list(
        &boards(&server::worktree_id(args.worktree.clone())?, None)?,
        out,
    );
    Ok(())
}

fn search(args: &WhiteboardSearchArgs, out: &Output) -> Result<(), CliError> {
    render_list(
        &boards(
            &server::worktree_id(args.worktree.clone())?,
            Some(args.query.as_str()),
        )?,
        out,
    );
    Ok(())
}

fn get(args: &WhiteboardIdArgs, out: &Output) -> Result<(), CliError> {
    let board = get_board(&server::worktree_id(args.worktree.clone())?, &args.id)?;
    render_board(&board, out);
    Ok(())
}

fn edit(args: &WhiteboardEditArgs, out: &Output) -> Result<(), CliError> {
    let worktree_id = server::worktree_id(args.worktree.clone())?;
    let current = get_board(&worktree_id, &args.id)?;
    let scene = read_scene(&args.scene)?;
    let board: Whiteboard = parse(rpc(json!({
        "action": "edit",
        "worktreeId": worktree_id,
        "id": args.id,
        "title": args.title,
        "scene": scene,
        "expectedVersion": current.version,
    }))?)?;
    render_board(&board, out);
    Ok(())
}

fn delete(args: &WhiteboardDeleteArgs, out: &Output) -> Result<(), CliError> {
    let worktree_id = server::worktree_id(args.worktree.clone())?;
    let board = get_board(&worktree_id, &args.id)?;
    if !args.yes {
        confirm_delete(&board)?;
    }
    rpc(json!({ "action": "delete", "worktreeId": worktree_id, "id": args.id }))?;
    out.line(
        format!("Deleted {} ({})", board.title, board.id),
        &json!({ "deleted": true, "id": board.id }),
    );
    Ok(())
}

fn view(args: &WhiteboardViewArgs, out: &Output) -> Result<(), CliError> {
    let result = rpc(json!({
        "action": "view",
        "worktreeId": server::worktree_id(args.worktree.clone())?,
        "id": args.id,
    }))?;
    let data = result["data"]
        .as_str()
        .ok_or_else(|| CliError::server("whiteboard view returned no PNG data"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| CliError::server(format!("invalid PNG data: {error}")))?;
    std::fs::write(&args.output, &bytes)
        .map_err(|error| CliError::other(format!("write {}: {error}", args.output)))?;
    out.line(
        format!("Wrote {} ({} bytes)", args.output, bytes.len()),
        &json!({ "id": args.id, "path": args.output, "bytes": bytes.len() }),
    );
    Ok(())
}

fn read_scene(path: &str) -> Result<ExcalidrawScene, CliError> {
    let source = if path == "-" {
        server::read_stdin()?
    } else {
        std::fs::read_to_string(path)
            .map_err(|error| CliError::config(format!("read {path}: {error}")))?
    };
    serde_json::from_str(&source)
        .map_err(|error| CliError::config(format!("invalid Excalidraw scene JSON: {error}")))
}

fn boards(worktree_id: &str, query: Option<&str>) -> Result<Vec<Whiteboard>, CliError> {
    parse(rpc(json!({
        "action": "list",
        "worktreeId": worktree_id,
        "query": query,
    }))?)
}

fn get_board(worktree_id: &str, id: &str) -> Result<Whiteboard, CliError> {
    parse(rpc(json!({
        "action": "get",
        "worktreeId": worktree_id,
        "id": id,
    }))?)
}

fn rpc(payload: Value) -> Result<Value, CliError> {
    server::rpc(ProtocolRpcMethod::Whiteboards, payload)
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CliError> {
    serde_json::from_value(value).map_err(|error| CliError::server(error.to_string()))
}

fn confirm_delete(board: &Whiteboard) -> Result<(), CliError> {
    if !std::io::stdin().is_terminal() {
        return Err(CliError::config(
            "`whiteboard delete` is destructive; pass --yes for non-interactive use",
        ));
    }
    println!("Delete whiteboard `{}` ({})?", board.title, board.id);
    print!("Type `yes` to continue: ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    if answer.trim() != "yes" {
        return Err(CliError::config("cancelled"));
    }
    Ok(())
}

fn render_board(board: &Whiteboard, out: &Output) {
    out.line(
        format!("{} · {} · v{}", board.title, board.id, board.version),
        board,
    );
}

fn render_list(boards: &[Whiteboard], out: &Output) {
    out.list(
        ["TITLE", "ID", "VERSION", "UPDATED"],
        boards,
        |board| {
            [
                board.title.clone(),
                board.id.clone(),
                board.version.to_string(),
                board.updated_at.to_string(),
            ]
        },
        &boards,
    );
}
