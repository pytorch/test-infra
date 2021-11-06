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

/// Represents a single lint message.
#[derive(Debug, Deserialize, Clone, Serialize)]
struct LintMessageSerde {
    /// Path to the file this lint message pertains to.
    /// This can either be an absolute path, or relative to the current working
    /// directory when `lintrunner` was invoked.
    ///
    /// When the path is None, this message will be displayed as a general
    /// linter error.
    path: Option<String>,

    /// The line number that the lint message pertains to.
    line: Option<usize>,

    /// The column number that the lint message pertains to.
    char: Option<usize>,

    /// Linter code (e.g. `FLAKE8`). Must match the code specified in the linter config.
    code: String,

    /// The severity of the lint message.
    severity: LintSeverity,

    /// The name of the type of lint message, e.g. "syntax error"
    name: String,

    /// A more substantive description of the lint message. This can include
    /// suggestions for remediation, links to further documentation, etc.
    description: Option<String>,

    /// The original text of the entire file, encoded as a utf-8 string.
    #[serde(skip_serializing_if = "Option::is_none")]
    original: Option<String>,

    /// If a fix was suggested, this is the replacement text of the entire file,
    /// encoded as a utf-8 string.
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
