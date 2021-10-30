use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::path::AbsPath;

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
struct LintMessageSerde {
    path: String,
    line: Option<usize>,
    char: Option<usize>,
    code: String,
    severity: LintSeverity,
    name: String,
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replacement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bypass_changed_line_filtering: Option<bool>,
}

pub struct LintMessage {
    pub path: AbsPath,
    pub line: Option<usize>,
    pub char: Option<usize>,
    pub code: String,
    pub severity: LintSeverity,
    pub name: String,
    pub description: Option<String>,
    pub original: Option<String>,
    pub replacement: Option<String>,
    pub bypass_changed_line_filtering: Option<bool>,
}

impl LintMessage {
    pub fn from_json(json: &str) -> Result<LintMessage> {
        let raw_msg: LintMessageSerde = serde_json::from_str(json)?;
        dbg!(&raw_msg.path);
        Ok(LintMessage {
            path: AbsPath::new(PathBuf::from(raw_msg.path))?,
            line: raw_msg.line,
            char: raw_msg.char,
            code: raw_msg.code,
            severity: raw_msg.severity,
            name: raw_msg.name,
            description: raw_msg.description,
            original: raw_msg.original,
            replacement: raw_msg.replacement,
            bypass_changed_line_filtering: raw_msg.bypass_changed_line_filtering,
        })
    }
}
