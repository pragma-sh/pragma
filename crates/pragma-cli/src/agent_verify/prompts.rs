use std::collections::HashMap;
use std::fs;

/// Prompt templates keyed by scenario id.
#[derive(Clone)]
pub struct Prompts {
    values: HashMap<String, String>,
}

impl Prompts {
    /// Builds defaults and merges optional JSON file overrides.
    pub fn load(path: Option<&str>) -> Result<Self, String> {
        let mut values = defaults();
        if let Some(path) = path {
            let contents = fs::read_to_string(path)
                .map_err(|error| format!("read prompt overrides {path}: {error}"))?;
            let overrides: HashMap<String, String> = serde_json::from_str(&contents)
                .map_err(|error| format!("decode prompt overrides {path}: {error}"))?;
            values.extend(overrides);
        }
        Ok(Self { values })
    }

    /// Returns one required scenario prompt.
    pub fn get(&self, id: &str) -> Result<&str, String> {
        self.values
            .get(id)
            .map(String::as_str)
            .ok_or_else(|| format!("missing prompt for scenario {id}"))
    }
}

/// Parses CLI-style escape sequences into PTY bytes.
pub fn parse_escapes(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            output.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        let escaped = *bytes
            .get(index)
            .ok_or_else(|| "abort input ends with an incomplete escape".to_string())?;
        match escaped {
            b'e' => output.push(0x1b),
            b'r' => output.push(b'\r'),
            b'n' => output.push(b'\n'),
            b't' => output.push(b'\t'),
            b'\\' => output.push(b'\\'),
            b'x' => {
                let high = *bytes
                    .get(index + 1)
                    .ok_or_else(|| "\\x escape requires two hex digits".to_string())?;
                let low = *bytes
                    .get(index + 2)
                    .ok_or_else(|| "\\x escape requires two hex digits".to_string())?;
                output.push((hex(high)? << 4) | hex(low)?);
                index += 2;
            }
            other => return Err(format!("unsupported escape: \\{}", char::from(other))),
        }
        index += 1;
    }
    Ok(output)
}

fn hex(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(format!("invalid hex digit: {}", char::from(value))),
    }
}

fn defaults() -> HashMap<String, String> {
    [
        ("basic-reply", "Reply with exactly two short sentences. Do not use tools and do not ask questions."),
        ("session-name", "Reply with one short sentence about naming things. Do not use tools and do not ask questions."),
        ("command-no-permission", "Run this safe shell command exactly, then report its numeric output: date +%s. Do not ask for permission and do not substitute another command."),
        ("question-answer", "Use your interactive question tool now. Ask exactly: Choose Red or Blue? Offer exactly Red and Blue, then stop and wait for the answer."),
        ("question-dismiss", "Use your interactive question tool now. Ask exactly: Choose Circle or Square? Offer exactly Circle and Square, then wait for the answer."),
        ("question-free-text", "Use your interactive question tool now. Ask exactly: What verification marker should I use? Offer exactly Alpha and Beta, then stop and wait. The verifier will answer with custom free text. The answer may arrive directly or as a follow-up message starting with: Answer to question. Either way, once you have it, reply with the exact marker text you received."),
        ("command-allow", "Use the shell tool exactly once with command `ls /pragma-verify-approval` and workdir `/etc`, then report its output. Do not substitute another command or workdir."),
        ("command-deny", "Use the shell tool exactly once with command `ls /pragma-verify-denied` and workdir `/etc`, then stop if permission is denied. Do not substitute another command or workdir."),
        ("decision-timeout", "Use the shell tool exactly once with command `ls /pragma-verify-timeout` and workdir `/etc`, then wait for permission. Do not substitute another command or workdir."),
        ("subagent", "Spawn two parallel sub-agents. Ask one for a memoization tip and one for a tail-recursion tip. Wait for both and summarize their answers."),
        ("abort-mid-run", "Write a detailed comparison of merge sort, quicksort, heapsort, and insertion sort, including tradeoffs and examples."),
        ("interrupt-event", "Draft an in-depth guide to diagnosing latency in a distributed service, with examples and a checklist."),
        ("abort-mid-question", "Use your interactive question tool now. Ask exactly: Choose Tea or Coffee? Offer Tea and Coffee, then wait."),
        ("abort-mid-approval", "Use the shell tool exactly once with command `ls /pragma-verify-abort-approval` and workdir `/etc`, then wait for permission. Do not substitute another command or workdir."),
        ("crash-exit", "Reply with a detailed explanation of sorting algorithms long enough to remain busy for several seconds."),
    ]
    .into_iter()
    .map(|(id, prompt)| (id.to_string(), prompt.to_string()))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{defaults, parse_escapes};

    #[test]
    fn parses_abort_escapes() {
        assert_eq!(
            parse_escapes(r"\e\x1b\r\n\t\\").unwrap(),
            b"\x1b\x1b\r\n\t\\"
        );
    }

    #[test]
    fn rejects_bad_hex() {
        assert!(parse_escapes(r"\xzz").is_err());
        assert!(parse_escapes(r"\x1").is_err());
    }

    #[test]
    fn approval_prompts_require_an_external_workdir() {
        let prompts = defaults();
        for id in [
            "command-allow",
            "command-deny",
            "decision-timeout",
            "abort-mid-approval",
        ] {
            let prompt = prompts.get(id).expect("approval prompt");
            assert!(prompt.contains("workdir `/etc`"));
            assert!(!prompt.contains("$HOME"));
        }
    }

    #[test]
    fn behaviorally_similar_scenarios_use_distinct_prompts() {
        let prompts = defaults();
        for ids in [
            ["question-answer", "question-dismiss", "abort-mid-question"],
            ["abort-mid-run", "interrupt-event", "crash-exit"],
        ] {
            let unique = ids
                .map(|id| prompts.get(id).expect("scenario prompt"))
                .into_iter()
                .collect::<std::collections::HashSet<_>>();
            assert_eq!(unique.len(), ids.len());
        }
    }
}
