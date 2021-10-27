use std::{collections::HashSet, fs, path::Path};

use crate::linter::Linter;
use anyhow::{Context, Result};
use glob::Pattern;
use log::debug;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct LintRunnerConfig {
    #[serde(rename = "linter")]
    linters: Vec<LintConfig>,
}

#[derive(Serialize, Deserialize)]
struct LintConfig {
    name: String,
    include_patterns: Vec<String>,
    exclude_patterns: Vec<String>,
    args: Vec<String>,
}

/// Given options specified by the user, return a list of linters to run.
pub fn get_linters_from_config(
    config_path: &Path,
    skipped_linters: Option<HashSet<String>>,
    taken_linters: Option<HashSet<String>>,
) -> Result<Vec<Linter>> {
    let lint_runner_config = LintRunnerConfig::new(config_path)?;
    let mut linters = Vec::new();
    for lint_config in lint_runner_config.linters {
        let include_patterns = patterns_from_strs(&lint_config.include_patterns)?;
        let exclude_patterns = patterns_from_strs(&lint_config.exclude_patterns)?;
        linters.push(Linter {
            name: lint_config.name,
            include_patterns,
            exclude_patterns,
            commands: lint_config.args,
        });
    }
    debug!(
        "Found linters: {:?}",
        linters.iter().map(|l| &l.name).collect::<Vec<_>>()
    );

    // Apply --take
    if let Some(taken_linters) = taken_linters {
        debug!("Taking linters: {:?}", taken_linters);
        linters = linters
            .into_iter()
            .filter(|linter| taken_linters.contains(&linter.name))
            .collect();
    }

    // Apply --skip
    if let Some(skipped_linters) = skipped_linters {
        debug!("Skipping linters: {:?}", skipped_linters);
        linters = linters
            .into_iter()
            .filter(|linter| !skipped_linters.contains(&linter.name))
            .collect();
    }
    Ok(linters)
}

impl LintRunnerConfig {
    pub fn new(path: &Path) -> Result<LintRunnerConfig> {
        let lint_config = fs::read_to_string(path)
            .context(format!("Failed to read config file: '{}'.", path.display()))?;
        Ok(toml::from_str(&lint_config).context(format!(
            "Config file '{}' had invalid schema",
            path.display()
        ))?)
    }
}

fn patterns_from_strs(pattern_strs: &Vec<String>) -> Result<Vec<Pattern>> {
    pattern_strs
        .iter()
        .map(|pattern_str| {
            Pattern::new(pattern_str).map_err(|err| {
                anyhow::Error::msg(err)
                    .context("Could not parse pattern from linter configuration.")
            })
        })
        .collect::<Result<Vec<Pattern>>>()
}
