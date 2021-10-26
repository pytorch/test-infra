use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct LintConfig {
    #[serde(rename = "linter")]
    pub linters: Vec<LinterConfig>,
}

impl LintConfig {
    pub fn new(path: &Path) -> Result<LintConfig> {
        let lint_config = fs::read_to_string(path)
            .context(format!("Failed to read config file: '{}'.", path.display()))?;
        Ok(toml::from_str(&lint_config).context(format!(
            "Config file '{}' had invalid schema",
            path.display()
        ))?)
    }
}

#[derive(Serialize, Deserialize)]
pub struct LinterConfig {
    pub name: String,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub args: Vec<String>,
}
