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

/// Represents a single lint message. This version of the struct is used as the
/// canonical protocol representation, intended to be serialized directly into JSON.
#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct LintMessage {
    /// Path to the file this lint message pertains to.
    ///
    /// This can either be an absolute path, or relative to the current working
    /// directory when `lintrunner` was invoked.
    ///
    /// When the path is None, this message will be displayed as a general
    /// linter error.
    pub path: Option<String>,

    /// The line number that the lint message pertains to.
    pub line: Option<usize>,

    /// The column number that the lint message pertains to.
    pub char: Option<usize>,

    /// Linter code (e.g. `FLAKE8`). Must match the code specified in the linter config.
    pub code: String,

    /// The severity of the lint message.
    pub severity: LintSeverity,

    /// The name of the type of lint message, e.g. "syntax error"
    pub name: String,

    /// A more substantive description of the lint message. This can include
    /// suggestions for remediation, links to further documentation, etc.
    pub description: Option<String>,

    /// The original text of the entire file, encoded as a utf-8 string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,

    /// If a fix was suggested, this is the replacement text of the entire file,
    /// encoded as a utf-8 string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
}
