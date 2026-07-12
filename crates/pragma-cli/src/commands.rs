//! Brokered command handlers: build the JSON payload for each
//! [`ControlMethod`], send it through the broker, and render the reply.
//!
//! Every GUI-required command goes through [`crate::broker`]; the server routes
//! each to the running app, which executes the matching Tauri command. With no
//! app, the CLI prints the canonical "Pragma is not running" error and exits
//! non-zero.

use pragma_constants::ControlMethod;

use comfy_table::{ContentArrangement, Table};

use crate::broker;
use crate::cli::{
    AgentStartArgs, BrowserCommand, BrowserScreenshotArgs, BrowserScrollArgs, DiffSideArg,
    SplitAddTabArgs, SplitCommand, SplitSetArgs, TabExecArgs, TabListArgs, TabOpenArgs,
    WorktreeCommand, WorktreeCreateArgs, WorktreeDeleteArgs,
};
use crate::output::Output;
use crate::server;
use crate::server::CliError;

// -------------------------- worktree --------------------------

pub fn worktree(cmd: &WorktreeCommand, out: &Output) -> Result<(), CliError> {
    match cmd {
        WorktreeCommand::List { worktree } => {
            let current = server::optional_worktree_id(worktree.worktree.clone());
            let value = broker::request(
                ControlMethod::WorktreesList,
                serde_json::json!({ "worktreeId": current }),
            )?;
            render_worktrees(&value, out)
        }
        WorktreeCommand::Create(args) => worktree_create(args, out),
        WorktreeCommand::Rename { id, title } => {
            let value = broker::request(
                ControlMethod::WorktreeRename,
                serde_json::json!({ "worktreeId": id, "title": title }),
            )?;
            print_line(out, &value, |v| format!("renamed {}", short_id(v)));
            Ok(())
        }
        WorktreeCommand::Hide { id } => {
            let value = broker::request(
                ControlMethod::WorktreeSetHidden,
                serde_json::json!({ "worktreeId": id, "hidden": true }),
            )?;
            print_line(out, &value, |v| format!("hidden {}", short_id(v)));
            Ok(())
        }
        WorktreeCommand::Unhide { id } => {
            let value = broker::request(
                ControlMethod::WorktreeSetHidden,
                serde_json::json!({ "worktreeId": id, "hidden": false }),
            )?;
            print_line(out, &value, |v| format!("unhidden {}", short_id(v)));
            Ok(())
        }
        WorktreeCommand::Delete(args) => worktree_delete(args, out),
    }
}

pub fn worktree_create(args: &WorktreeCreateArgs, out: &Output) -> Result<(), CliError> {
    let parent = server::worktree_id(args.parent.clone())?;
    let value = broker::request(
        ControlMethod::WorktreeCreate,
        serde_json::json!({
            "parentWorktreeId": parent,
            "branch": args.branch,
            "title": args.title,
        }),
    )?;
    print_line(out, &value, |v| {
        format!(
            "created {} {} → {}",
            short_id(v),
            v.get("branch").and_then(|b| b.as_str()).unwrap_or("?"),
            v.get("path").and_then(|p| p.as_str()).unwrap_or("?"),
        )
    });
    Ok(())
}

fn worktree_delete(args: &WorktreeDeleteArgs, out: &Output) -> Result<(), CliError> {
    broker::request_void(
        ControlMethod::WorktreeDelete,
        serde_json::json!({
            "worktreeId": args.id,
            "deleteBranch": args.delete_branch,
            "force": args.force,
        }),
    )?;
    out.line(
        format!("deleted {}", args.id),
        &serde_json::json!({ "id": args.id }),
    );
    Ok(())
}

fn render_worktrees(value: &serde_json::Value, out: &Output) -> Result<(), CliError> {
    if out.is_structured() {
        out.line("", value);
        return Ok(());
    }
    let arr = value
        .as_array()
        .ok_or_else(|| CliError::other("expected worktree array"))?;
    if arr.is_empty() {
        return Ok(());
    }
    let mut table = Table::new();
    table
        .load_preset(comfy_table::presets::UTF8_FULL)
        .apply_modifier(comfy_table::modifiers::UTF8_ROUND_CORNERS)
        .set_content_arrangement(ContentArrangement::Disabled)
        .set_header(["ID", "BRANCH", "TITLE", "MAIN", "HIDDEN"]);
    let mut rows = arr
        .iter()
        .map(|w| {
            (
                json_bool(w, "is_main"),
                w.get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_string(),
                w.get("branch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
                    .to_string(),
                w.get("title")
                    .and_then(|v| v.as_str())
                    .or(Some("—"))
                    .unwrap_or("—")
                    .to_string(),
                json_bool(w, "hidden"),
            )
        })
        .collect::<Vec<_>>();
    // is_main first.
    rows.sort_by_key(|r| !r.0);
    for (is_main, id, branch, title, hidden) in rows {
        table.add_row([
            id,
            branch,
            title,
            if is_main { "yes" } else { "no" }.to_string(),
            if hidden { "yes" } else { "no" }.to_string(),
        ]);
    }
    println!("{table}");
    Ok(())
}

fn json_bool(v: &serde_json::Value, key: &str) -> bool {
    v.get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn short_id(v: &serde_json::Value) -> String {
    v.get("id")
        .and_then(|i| i.as_str())
        .map_or_else(|| "?".to_string(), short_uuid)
}

fn short_uuid(id: &str) -> String {
    if id.len() >= 8 {
        id[..8].to_string()
    } else {
        id.to_string()
    }
}

// -------------------------- tab --------------------------

pub fn tab_list(args: &TabListArgs, out: &Output) -> Result<(), CliError> {
    let worktree = server::optional_worktree_id(args.worktree.clone());
    let value = broker::request(
        ControlMethod::TabsList,
        serde_json::json!({ "worktreeId": worktree, "all": args.all }),
    )?;
    let arr = value
        .as_array()
        .ok_or_else(|| CliError::other("expected tab array"))?;
    out.list(
        ["ID", "KIND", "TITLE", "URL/FILE"],
        arr,
        |t| {
            [
                short_uuid(t.get("id").and_then(|v| v.as_str()).unwrap_or("?")),
                t.get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
                    .to_string(),
                t.get("title")
                    .and_then(|v| v.as_str())
                    .or(Some("—"))
                    .unwrap_or("—")
                    .to_string(),
                t.get("url")
                    .and_then(|v| v.as_str())
                    .or_else(|| t.get("filePath").and_then(|v| v.as_str()))
                    .unwrap_or("—")
                    .to_string(),
            ]
        },
        &arr,
    );
    Ok(())
}

pub fn tab_open(args: &TabOpenArgs, out: &Output) -> Result<(), CliError> {
    let worktree = server::worktree_id(args.worktree.clone())?;
    let value = broker::request(
        ControlMethod::TabOpen,
        serde_json::json!({
            "worktreeId": worktree,
            "kind": args.kind.as_wire(),
            "title": args.title,
            "command": args.command,
            "url": args.url,
            "file": args.file,
            "diffSide": args.diff_side.map(DiffSideArg::as_wire),
        }),
    )?;
    print_line(out, &value, |v| {
        format!(
            "opened tab {}",
            v.get("id")
                .and_then(|i| i.as_str())
                .map_or_else(|| "?".to_string(), short_uuid)
        )
    });
    Ok(())
}

pub fn tab_close(tab: &str, out: &Output) -> Result<(), CliError> {
    broker::request_void(ControlMethod::TabClose, serde_json::json!({ "tabId": tab }))?;
    out.line(
        format!("closed {tab}"),
        &serde_json::json!({ "tabId": tab }),
    );
    Ok(())
}

pub fn tab_rename(tab: &str, title: &str, out: &Output) -> Result<(), CliError> {
    let value = broker::request(
        ControlMethod::TabRename,
        serde_json::json!({ "tabId": tab, "title": title }),
    )?;
    print_line(out, &value, |v| {
        format!(
            "renamed tab {}",
            v.get("id")
                .and_then(|i| i.as_str())
                .map_or_else(|| "?".to_string(), short_uuid)
        )
    });
    Ok(())
}

pub fn tab_exec(args: &TabExecArgs, out: &Output) -> Result<(), CliError> {
    let worktree = server::worktree_id(args.worktree.clone())?;
    if args.command.is_empty() {
        return Err(CliError::other("no command given"));
    }
    let value = broker::request(
        ControlMethod::TabExec,
        serde_json::json!({
            "worktreeId": worktree,
            "command": args.command,
        }),
    )?;
    if out.is_structured() {
        out.line("", &value);
        return Ok(());
    }
    let stdout = value.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
    let stderr = value.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
    print!("{stdout}");
    eprint!("{stderr}");
    Ok(())
}

// -------------------------- split --------------------------

pub fn split(cmd: &SplitCommand, out: &Output) -> Result<(), CliError> {
    match cmd {
        SplitCommand::Set(args) => split_set(args, out),
        SplitCommand::AddTab(args) => split_add_tab(args, out),
        SplitCommand::Clear { worktree } => {
            broker::request_void(
                ControlMethod::SplitClear,
                serde_json::json!({ "worktreeId": worktree }),
            )?;
            out.line(
                format!("cleared {worktree}"),
                &serde_json::json!({ "worktreeId": worktree }),
            );
            Ok(())
        }
    }
}

fn split_set(args: &SplitSetArgs, out: &Output) -> Result<(), CliError> {
    let layout = if args.layout == "-" {
        server::read_stdin()?
    } else {
        args.layout.clone()
    };
    // Validate it parses as a SplitNode so the CLI rejects malformed trees
    // before round-tripping to the app.
    parse_split(&layout)?;
    broker::request_void(
        ControlMethod::SplitSet,
        serde_json::json!({ "worktreeId": args.worktree, "layout": layout }),
    )?;
    out.line(
        "split set",
        &serde_json::json!({ "worktreeId": args.worktree }),
    );
    Ok(())
}

fn split_add_tab(args: &SplitAddTabArgs, out: &Output) -> Result<(), CliError> {
    broker::request_void(
        ControlMethod::SplitAddTab,
        serde_json::json!({
            "worktreeId": args.worktree,
            "addTab": {
                "side": args.side.as_wire(),
                "kind": args.kind.as_wire(),
                "command": args.command,
                "url": args.url,
                "file": args.file,
            },
        }),
    )?;
    out.line(
        "split add-tab",
        &serde_json::json!({ "worktreeId": args.worktree }),
    );
    Ok(())
}

/// Parses a JSON string as a shared `SplitNode`. Errors clearly so invalid trees
/// are rejected before reaching the app.
pub fn parse_split(layout: &str) -> Result<pragma_constants::SplitNode, CliError> {
    serde_json::from_str::<pragma_constants::SplitNode>(layout)
        .map_err(|e| CliError::other(format!("invalid split layout: {e}")))
}

// -------------------------- browser --------------------------

pub fn browser(cmd: &BrowserCommand, out: &Output) -> Result<(), CliError> {
    match cmd {
        BrowserCommand::Navigate { tab, url } => {
            browser_void(
                ControlMethod::BrowserNavigate,
                tab,
                |t| serde_json::json!({ "tabId": t, "url": url }),
            )?;
            out.line(
                format!("navigated {tab} -> {url}"),
                &serde_json::json!({ "tabId": tab, "url": url }),
            );
            Ok(())
        }
        BrowserCommand::Back { tab } => {
            simple_browser(ControlMethod::BrowserBack, tab, "back", out)
        }
        BrowserCommand::Forward { tab } => {
            simple_browser(ControlMethod::BrowserForward, tab, "forward", out)
        }
        BrowserCommand::Reload { tab } => {
            simple_browser(ControlMethod::BrowserReload, tab, "reloaded", out)
        }
        BrowserCommand::Close { tab } => {
            simple_browser(ControlMethod::BrowserClose, tab, "closed", out)
        }
        BrowserCommand::Scroll(args) => browser_scroll(args, out),
        BrowserCommand::Focus { tab, selector } => {
            browser_selector(ControlMethod::BrowserFocus, tab, selector, "focused", out)
        }
        BrowserCommand::Click { tab, selector } => {
            browser_selector(ControlMethod::BrowserClick, tab, selector, "clicked", out)
        }
        BrowserCommand::Screenshot(args) => browser_screenshot(args, out),
        BrowserCommand::Exec { tab, js } => browser_exec(tab, js, out),
    }
}

fn simple_browser(
    method: ControlMethod,
    tab: &str,
    verb: &str,
    out: &Output,
) -> Result<(), CliError> {
    browser_void(method, tab, |t| serde_json::json!({ "tabId": t }))?;
    out.line(
        format!("{verb} {tab}"),
        &serde_json::json!({ "tabId": tab }),
    );
    Ok(())
}

fn browser_void(
    method: ControlMethod,
    tab: &str,
    payload: impl FnOnce(&str) -> serde_json::Value,
) -> Result<(), CliError> {
    broker::request_void(method, payload(tab))
}

fn browser_scroll(args: &BrowserScrollArgs, out: &Output) -> Result<(), CliError> {
    let to = args.to.map(|a| match a {
        crate::cli::ScrollAnchorArg::Top => "top",
        crate::cli::ScrollAnchorArg::Bottom => "bottom",
    });
    let value = broker::request(
        ControlMethod::BrowserScroll,
        serde_json::json!({ "tabId": args.tab, "x": args.x, "y": args.y, "to": to }),
    )?;
    print_line(out, &value, |_| format!("scrolled {}", args.tab));
    Ok(())
}

fn browser_selector(
    method: ControlMethod,
    tab: &str,
    selector: &str,
    verb: &str,
    out: &Output,
) -> Result<(), CliError> {
    let value = broker::request(
        method,
        serde_json::json!({ "tabId": tab, "selector": selector }),
    )?;
    print_line(out, &value, |_| format!("{verb} {tab}"));
    Ok(())
}

fn browser_screenshot(args: &BrowserScreenshotArgs, out: &Output) -> Result<(), CliError> {
    let value = broker::request(
        ControlMethod::BrowserScreenshot,
        serde_json::json!({ "tabId": args.tab, "out": args.out }),
    )?;
    print_line(out, &value, |v| {
        let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("<unset>");
        format!("screenshot {path}")
    });
    Ok(())
}

fn browser_exec(tab: &str, js: &str, out: &Output) -> Result<(), CliError> {
    let script = if js == "-" {
        server::read_stdin()?
    } else {
        js.to_string()
    };
    let value = broker::request(
        ControlMethod::BrowserEval,
        serde_json::json!({ "tabId": tab, "script": script }),
    )?;
    if out.is_structured() {
        out.line("", &value);
    } else {
        let result = value
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        println!("{result}");
    }
    Ok(())
}

// -------------------------- agent start --------------------------

pub fn agent_start(args: &AgentStartArgs, out: &Output) -> Result<(), CliError> {
    let worktree = server::worktree_id(args.worktree.clone())?;
    let value = broker::request(
        ControlMethod::AgentStart,
        serde_json::json!({
            "worktreeId": worktree,
            "agent": args.agent,
            "model": args.model,
            "prompt": args.prompt,
        }),
    )?;
    print_line(out, &value, |v| {
        let tab = v.get("tabId").and_then(|t| t.as_str()).unwrap_or("?");
        format!(
            "started {} in {} tab={}",
            args.agent,
            short_uuid(&worktree),
            tab
        )
    });
    Ok(())
}

// -------------------------- helpers --------------------------

fn print_line<F: FnOnce(&serde_json::Value) -> String>(
    out: &Output,
    value: &serde_json::Value,
    human: F,
) {
    out.line(human(value), value);
}
