//! Pre-launch shell commands in an agent prompt.
//!
//! `CONSTANTS.agents.prelaunch_command_prefix` (`!!`) followed by a code span —
//! `` !!`bun run test` ``, anywhere in the text — is a command to run headlessly
//! in the agent's worktree before the agent starts. The agent receives the
//! prompt with each chip reduced to its code span, followed by each command's
//! output. These are the pure rules — splitting and formatting — and
//! the TypeScript twin in `apps/pragma/src/lib/prelaunch-commands.ts` must stay
//! byte-for-byte identical, which the matching tests on both sides pin. The
//! desktop runs commands for single launches; the host's fanout provisioning
//! uses this module for each attempt.

use pragma_constants::CONSTANTS;

use crate::exec::CommandResult;

/// Where `@` context blocks begin in a stored prompt (see the plugin API's
/// `formatPromptWithContext`). Commands are never looked for past it.
const CONTEXT_START: &str = "\n\n<context mention=\"";
const INTRO: &str =
    "Before this session started, I ran these commands in the worktree. Their output follows.";

/// A prompt with its pre-launch commands split off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptCommands {
    /// The user's text with each chip reduced to its code span (context blocks excluded).
    pub prompt: String,
    /// Non-empty commands, in prompt order.
    pub commands: Vec<String>,
    /// Attached `@` context blocks, verbatim, including their leading blank line.
    pub context: String,
}

/// Pulls the `` !!`command` `` chips out of a stored prompt. Each is replaced
/// by its plain code span, so the sentence still reads naturally, and the
/// non-empty commands come back in order. Fenced code blocks and attached
/// context are left alone.
#[must_use]
pub fn split_prompt_commands(stored: &str) -> PromptCommands {
    let (text, context) = stored
        .find(CONTEXT_START)
        .map_or((stored, ""), |at| stored.split_at(at));
    let mut lines = Vec::new();
    let mut commands = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(marker) = fence_marker(line) {
            fence = match fence {
                None => Some(marker),
                Some(open) if marker.0 == open.0 && marker.1 >= open.1 => None,
                open => open,
            };
        }
        lines.push(if fence.is_none() {
            replace_commands(line, &mut commands)
        } else {
            line.to_string()
        });
    }
    PromptCommands {
        prompt: lines.join("\n").trim().to_string(),
        commands,
        context: context.to_string(),
    }
}

/// One `` !!`command` `` found in markdown source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommandMatch {
    /// Byte index just past the closing backticks.
    pub end: usize,
    /// The code span alone (`` `command` ``), what the agent reads in its place.
    pub span: String,
    /// The command, code-span padding stripped.
    pub command: String,
}

/// Reads a `` !!`command` `` starting exactly at byte `at`: the prefix, a run
/// of backticks, and the next run of the same length. `None` when there is
/// none, e.g. an unclosed span.
#[must_use]
pub fn match_shell_command(source: &str, at: usize) -> Option<ShellCommandMatch> {
    let prefix = CONSTANTS.agents.prelaunch_command_prefix.as_str();
    let rest = source.get(at..)?;
    if !rest.starts_with(prefix) || !rest[prefix.len()..].starts_with('`') {
        return None;
    }
    let open = at + prefix.len();
    let content_start = run_end(source, open);
    let ticks = content_start - open;
    let mut search = content_start;
    loop {
        let close = search + source[search..].find('`')?;
        let close_end = run_end(source, close);
        if close_end - close == ticks {
            return Some(ShellCommandMatch {
                end: close_end,
                span: source[open..close_end].to_string(),
                command: strip_span_padding(&source[content_start..close])
                    .trim()
                    .to_string(),
            });
        }
        search = close_end;
    }
}

/// Swaps each command chip on one line for its code span, collecting the commands.
fn replace_commands(line: &str, commands: &mut Vec<String>) -> String {
    let prefix = CONSTANTS.agents.prelaunch_command_prefix.as_str();
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    let mut next = line.find(prefix);
    while let Some(start) = next {
        let Some(found) = match_shell_command(line, start) else {
            next = find_from(line, prefix, start + 1);
            continue;
        };
        out.push_str(&line[at..start]);
        if !found.command.is_empty() {
            commands.push(found.command);
            out.push_str(&found.span);
        }
        at = found.end;
        next = find_from(line, prefix, at);
    }
    out.push_str(&line[at..]);
    out
}

fn find_from(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    haystack
        .get(from..)
        .and_then(|rest| rest.find(needle))
        .map(|offset| from + offset)
}

fn run_end(source: &str, from: usize) -> usize {
    from + source[from..]
        .bytes()
        .take_while(|byte| *byte == b'`')
        .count()
}

/// `CommonMark`: one leading and trailing space is padding when both are present.
fn strip_span_padding(content: &str) -> &str {
    if content.len() >= 2
        && content.starts_with(' ')
        && content.ends_with(' ')
        && !content.trim().is_empty()
    {
        &content[1..content.len() - 1]
    } else {
        content
    }
}

/// Rebuilds the prompt an agent receives once its commands have run: the
/// user's text, then one `<command-output>` element per command, then any
/// attached context. `results` are in command order.
#[must_use]
pub fn resolve_prompt(split: &PromptCommands, results: &[CommandResult]) -> String {
    format!(
        "{}{}",
        format_prompt_with_command_output(&split.prompt, results),
        split.context
    )
}

/// Appends each command and its output to `prompt`. Unchanged when no command ran.
#[must_use]
pub fn format_prompt_with_command_output(prompt: &str, results: &[CommandResult]) -> String {
    if results.is_empty() {
        return prompt.to_string();
    }
    let mut parts = Vec::with_capacity(results.len() + 2);
    let prompt = prompt.trim_end();
    if !prompt.is_empty() {
        parts.push(prompt.to_string());
    }
    parts.push(INTRO.to_string());
    parts.extend(results.iter().map(format_command_block));
    parts.join("\n\n")
}

/// A result for a command that never ran because the user skipped the batch.
#[must_use]
pub fn skipped_result(command: &str) -> CommandResult {
    CommandResult {
        command: command.to_string(),
        stdout: String::new(),
        stderr: String::new(),
        status: None,
        duration_ms: 0,
        cancelled: true,
    }
}

fn format_command_block(result: &CommandResult) -> String {
    let mut attributes = vec![format!("command=\"{}\"", escape_attribute(&result.command))];
    if let Some(status) = result.status {
        attributes.push(format!("exit-code=\"{status}\""));
    }
    if result.cancelled {
        attributes.push("skipped=\"true\"".to_string());
    }
    let tenths = result.duration_ms.saturating_add(50) / 100;
    attributes.push(format!("duration=\"{}.{}s\"", tenths / 10, tenths % 10));
    format!(
        "<command-output {}>\n{}\n</command-output>",
        attributes.join(" "),
        command_body(result)
    )
}

fn command_body(result: &CommandResult) -> String {
    let mut sections = Vec::new();
    let stdout = tail(result.stdout.trim_end());
    let stderr = tail(result.stderr.trim_end());
    if !stdout.is_empty() {
        sections.push(stdout);
    }
    if !stderr.is_empty() {
        sections.push(format!("[stderr]\n{stderr}"));
    }
    if result.cancelled {
        sections.push(
            if result.duration_ms > 0 {
                "(skipped by the user before it finished; output above is partial)"
            } else {
                "(skipped by the user; never ran)"
            }
            .to_string(),
        );
    }
    if sections.is_empty() {
        "(no output)".to_string()
    } else {
        sections.join("\n")
    }
}

/// Keeps the last `prelaunch_output_limit` characters, noting how many were dropped.
fn tail(text: &str) -> String {
    let limit =
        usize::try_from(CONSTANTS.agents.prelaunch_output_limit.get()).unwrap_or(usize::MAX);
    let length = text.chars().count();
    if length <= limit {
        return text.to_string();
    }
    let dropped = length - limit;
    let kept: String = text.chars().skip(dropped).collect();
    format!("[… {dropped} earlier characters truncated]\n{kept}")
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `(marker char, run length)` when `line` opens or closes a code fence.
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let marker = body.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = body.chars().take_while(|c| *c == marker).count();
    (run >= 3).then_some((marker, run))
}

#[cfg(test)]
mod tests {
    use super::{
        format_prompt_with_command_output, resolve_prompt, skipped_result, split_prompt_commands,
    };
    use crate::exec::CommandResult;

    fn result(command: &str, stdout: &str, status: Option<i32>) -> CommandResult {
        CommandResult {
            command: command.to_string(),
            stdout: stdout.to_string(),
            stderr: String::new(),
            status,
            duration_ms: 1234,
            cancelled: false,
        }
    }

    // The cases below mirror `prelaunch-commands.test.ts`; both sides must agree.

    #[test]
    fn splits_inline_commands_in_order_leaving_their_code_spans() {
        let split = split_prompt_commands(
            "Fix what !!`bun run test` reports, then check !!`git status`.\n\nThanks",
        );
        assert_eq!(
            split.prompt,
            "Fix what `bun run test` reports, then check `git status`.\n\nThanks"
        );
        assert_eq!(split.commands, ["bun run test", "git status"]);
        assert_eq!(split.context, "");
    }

    #[test]
    fn a_prompt_of_only_a_command_keeps_its_code_span() {
        let split = split_prompt_commands("!!`ls`");
        assert_eq!(split.prompt, "`ls`");
        assert_eq!(split.commands, ["ls"]);
    }

    #[test]
    fn reads_longer_fences_and_strips_code_span_padding() {
        let split = split_prompt_commands("run !!`` echo `hi` `` now");
        assert_eq!(split.commands, ["echo `hi`"]);
        assert_eq!(split.prompt, "run `` echo `hi` `` now");
    }

    #[test]
    fn leaves_bare_bangs_unclosed_spans_empty_commands_and_fences_alone() {
        let markdown =
            "Wow!! it works\n\n!!`unclosed\n\nempty !!`` `` here\n\n```sh\n!!`inside`\n```";
        let split = split_prompt_commands(markdown);
        assert_eq!(
            split.prompt,
            "Wow!! it works\n\n!!`unclosed\n\nempty  here\n\n```sh\n!!`inside`\n```"
        );
        assert_eq!(split.commands, [] as [std::string::String; 0]);
    }

    #[test]
    fn never_reads_commands_out_of_attached_context() {
        let stored =
            "Fix it with !!`ls`\n\n<context mention=\"@#1\" source=\"GitHub issues\">\n!!`rm -rf /`\n</context>";
        let split = split_prompt_commands(stored);
        assert_eq!(split.commands, ["ls"]);
        let prompt = resolve_prompt(&split, &[result("ls", "a.ts", Some(0))]);
        assert!(prompt.starts_with("Fix it with `ls`\n\nBefore this session started"));
        assert!(prompt.ends_with(
            "\n\n<context mention=\"@#1\" source=\"GitHub issues\">\n!!`rm -rf /`\n</context>"
        ));
    }

    #[test]
    fn formats_exit_code_duration_and_both_streams() {
        let mut command = result("echo \"<hi>\"", "out\n", Some(1));
        command.stderr = "err\n".to_string();
        assert_eq!(
            format_prompt_with_command_output("Fix the failures", &[command]),
            [
                "Fix the failures",
                "Before this session started, I ran these commands in the worktree. Their output follows.",
                "<command-output command=\"echo &quot;&lt;hi&gt;&quot;\" exit-code=\"1\" duration=\"1.2s\">\nout\n[stderr]\nerr\n</command-output>",
            ]
            .join("\n\n")
        );
    }

    #[test]
    fn marks_skipped_commands() {
        let mut partial = result("sleep 60", "partial", None);
        partial.cancelled = true;
        let prompt = format_prompt_with_command_output("", &[partial, skipped_result("never")]);
        assert!(prompt.starts_with("Before this session started"));
        assert!(prompt.contains("command=\"sleep 60\" skipped=\"true\""));
        assert!(prompt.contains("partial\n(skipped by the user before it finished"));
        assert!(prompt.contains("(skipped by the user; never ran)"));
    }

    #[test]
    fn keeps_only_the_tail_of_oversized_output() {
        let limit = usize::try_from(
            pragma_constants::CONSTANTS
                .agents
                .prelaunch_output_limit
                .get(),
        )
        .expect("limit");
        let stdout = format!("HEAD{}TAIL", "x".repeat(limit));
        let prompt = format_prompt_with_command_output("p", &[result("c", &stdout, Some(0))]);
        assert!(!prompt.contains("HEAD"));
        assert!(prompt.contains("TAIL"));
        assert!(prompt.contains("[… 8 earlier characters truncated]"));
    }

    #[test]
    fn rounds_durations_half_up_like_the_desktop() {
        let mut command = result("c", "", Some(0));
        command.duration_ms = 250;
        assert!(format_prompt_with_command_output("", &[command]).contains("duration=\"0.3s\""));
    }
}
