use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone, Serialize, Copy)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    Error,
    Warning,
    Advice,
    Disabled,
}

impl LintSeverity {
    pub fn label(self) -> &'static str {
        match self {
            Self::Error => "Error",
            Self::Warning => "Warning",
            Self::Advice => "Advice",
            Self::Disabled => "Disabled",
        }
    }
}

#[derive(Debug, Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintMessage {
    pub path: String,
    pub line: Option<usize>,
    pub char: Option<usize>,

    // #[serde(skip_serializing_if = "Option::is_none")]
    pub code: String,
    pub severity: LintSeverity,
    pub name: String,
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bypass_changed_line_filtering: Option<bool>,
}
