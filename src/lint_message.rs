use std::path::PathBuf;

use anyhow::{Context, Result};
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
    path: Option<String>,
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
}

#[derive(Debug)]
pub struct LintMessage {
    pub path: Option<AbsPath>,
    pub line: Option<usize>,
    pub char: Option<usize>,
    pub code: String,
    pub severity: LintSeverity,
    pub name: String,
    pub description: Option<String>,
    pub original: Option<String>,
    pub replacement: Option<String>,
}

impl LintMessage {
    pub fn from_json(json: &str) -> Result<LintMessage> {
        let raw_msg: LintMessageSerde = serde_json::from_str(json)?;
        let path = if let Some(raw_path) = raw_msg.path {
            Some(AbsPath::new(PathBuf::from(raw_path))?)
        } else {
            None
        };

        Ok(LintMessage {
            path,
            line: raw_msg.line,
            char: raw_msg.char,
            code: raw_msg.code,
            severity: raw_msg.severity,
            name: raw_msg.name,
            description: raw_msg.description,
            original: raw_msg.original,
            replacement: raw_msg.replacement,
        })
    }

    pub fn to_json(&self) -> Result<String> {
        let raw_msg = LintMessageSerde {
            path: self
                .path
                .as_ref()
                .map(|p| p.as_pathbuf().to_string_lossy().to_string()),
            line: self.line,
            char: self.char,
            code: self.code.clone(),
            severity: self.severity,
            name: self.name.clone(),
            description: self.description.clone(),
            original: self.original.clone(),
            replacement: self.replacement.clone(),
        };
        Ok(serde_json::to_string(&raw_msg)
            .with_context(|| format!("Failed to serialize lint message to json: {:#?}", self))?)
    }
}
