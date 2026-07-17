use serde::Serialize;
use serde_json::Value;

/// End-to-end verification report.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub agent: String,
    pub passed: bool,
    pub scenarios: Vec<ScenarioResult>,
    pub schema_errors: Vec<String>,
}

/// Result for one scenario.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioResult {
    pub id: String,
    pub name: String,
    pub status: ScenarioStatus,
    pub attempts: u32,
    pub duration_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<Value>,
}

/// Scenario terminal state.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScenarioStatus {
    Passed,
    Failed,
    Skipped,
}

impl std::fmt::Display for ScenarioStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Passed => formatter.write_str("passed"),
            Self::Failed => formatter.write_str("failed"),
            Self::Skipped => formatter.write_str("skipped"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> VerifyReport {
        VerifyReport {
            agent: "opencode".to_string(),
            passed: true,
            scenarios: vec![ScenarioResult {
                id: "catalog".to_string(),
                name: "catalog gate".to_string(),
                status: ScenarioStatus::Passed,
                attempts: 1,
                duration_ms: 2,
                failure: None,
                evidence: Vec::new(),
            }],
            schema_errors: Vec::new(),
        }
    }

    #[test]
    fn serializes_json_and_toon() {
        let value = serde_json::to_value(report()).expect("serialize report");
        assert_eq!(value["scenarios"][0]["status"], "passed");
        let encoded = toon_format::encode_default(&value).expect("encode toon");
        assert_eq!(
            toon_format::decode_default::<serde_json::Value>(&encoded).expect("decode toon"),
            value
        );
    }
}
