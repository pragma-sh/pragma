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
        ("command-no-permission", "Run this safe shell command exactly, then report its numeric output: date +%s. Do not ask for permission and do not substitute another command."),
        ("question-answer", "Use your interactive question tool now. Ask exactly: Choose Red or Blue? Offer exactly Red and Blue, then stop and wait for the answer."),
        ("question-dismiss", "Use your interactive question tool now. Ask exactly: Choose Red or Blue? Offer exactly Red and Blue, then stop and wait for the answer."),
        ("question-free-text", "Use your interactive question tool now. Ask exactly: What verification marker should I use? Offer exactly Alpha and Beta, then stop and wait. The verifier will answer with custom free text. The answer may arrive directly or as a follow-up message starting with: Answer to question. Either way, once you have it, reply with the exact marker text you received."),
        ("command-allow", "Run this shell command and then report its output: echo pragma-verify-approval. Do not substitute another command."),
        ("command-deny", "Run this shell command and then stop if permission is denied: echo pragma-verify-denied. Do not substitute another command."),
        ("decision-timeout", "Run this shell command and wait for permission: echo pragma-verify-timeout. Do not substitute another command."),
        ("subagent", "Spawn two parallel sub-agents. One writes about memoization and one writes about tail recursion, about 200 words each. Wait for both and summarize both."),
        ("abort-mid-run", "Count slowly from 1 to 1000, explaining each number in a sentence. Do not stop early."),
        ("interrupt-event", "Count slowly from 1 to 1000, explaining each number in a sentence. Do not stop early."),
        ("abort-mid-question", "Use your interactive question tool now. Ask exactly: Choose Red or Blue? Offer Red and Blue, then wait."),
        ("abort-mid-approval", "Run this shell command and wait for permission: echo pragma-verify-abort-approval."),
        ("crash-exit", "Reply with a detailed explanation of sorting algorithms long enough to remain busy for several seconds."),
    ]
    .into_iter()
    .map(|(id, prompt)| (id.to_string(), prompt.to_string()))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::parse_escapes;

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
}
