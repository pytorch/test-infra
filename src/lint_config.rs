use std::{collections::HashSet, fs};

use crate::{linter::Linter, path::AbsPath};
use anyhow::{bail, Context, Result};
use glob::Pattern;
use log::debug;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct LintRunnerConfig {
    #[serde(rename = "linter")]
    linters: Vec<LintConfig>,
}

/// Represents a single linter, along with all the information necessary to invoke it.
#[derive(Serialize, Deserialize)]
struct LintConfig {
    /// The name of the linter, conventionally capitals and numbers, no spaces,
    /// dashes, or underscores
    ///
    ///    e.g. 'FLAKE8' or 'CLANGFORMAT'
    code: String,

    /// A list of UNIX-style glob patterns. Paths matching any of these patterns
    /// will be linted. Patterns should be specified relative to the location
    /// of the config file.
    ///
    ///   e.g. `['torch/csrc/**/*.cpp', 'test/foo.py']`
    include_patterns: Vec<String>,

    /// A list of UNIX-style glob patterns. Paths matching any of these patterns
    /// will be never be linted, even if they match an include pattern.
    ///
    ///   e.g. `['torch/csrc/**/*.cpp', 'test/foo.py']`
    #[serde(skip_serializing_if = "Option::is_none")]
    exclude_patterns: Option<Vec<String>>,

    /// A list of arguments describing how the linter will be called. lintrunner
    /// will create a subprocess and invoke this command.
    ///
    /// If the string `{{PATHSFILE}}` is present in the list, it will be
    /// replaced by the location of a file containing a list of paths to lint,
    /// one per line.
    ///
    /// The paths in `{{PATHSFILE}}` will always be canoncalized (e.g. they are
    /// absolute paths with symlinks resolved).
    ///
    ///   e.g. `['python3', 'my_linter.py', '@{{PATHSFILE}}']`
    command: Vec<String>,

    /// A list of arguments describing how to set up the right dependencies for
    /// this linter. This command will be run when `lintrunner init` is called.
    ///
    /// The string `{{DRYRUN}}` must be present in the arguments provided. It
    /// will be 1 if `lintrunner init --dry-run` is called, 0 otherwise.
    ///
    /// If `{{DRYRUN}}` is set, this command is expected to not make any changes
    /// to the user's environment, instead it should only print what it will do.
    init_command: Option<Vec<String>>,
}

/// Given options specified by the user, return a list of linters to run.
pub fn get_linters_from_config(
    config_path: &AbsPath,
    skipped_linters: Option<HashSet<String>>,
    taken_linters: Option<HashSet<String>>,
) -> Result<Vec<Linter>> {
    let lint_runner_config = LintRunnerConfig::new(config_path)?;
    let mut linters = Vec::new();
    for lint_config in lint_runner_config.linters {
        let include_patterns = patterns_from_strs(&lint_config.include_patterns)?;
        let exclude_patterns = if let Some(exclude_patterns) = &lint_config.exclude_patterns {
            patterns_from_strs(exclude_patterns)?
        } else {
            Vec::new()
        };

        if lint_config.command.is_empty() {
            bail!(
                "Invalid linter configuration: '{}' has an empty command list.",
                lint_config.code
            );
        }
        linters.push(Linter {
            code: lint_config.code,
            include_patterns,
            exclude_patterns,
            commands: lint_config.command,
            init_commands: lint_config.init_command,
            config_path: config_path.clone(),
        });
    }
    debug!(
        "Found linters: {:?}",
        linters.iter().map(|l| &l.code).collect::<Vec<_>>()
    );

    // Apply --take
    if let Some(taken_linters) = taken_linters {
        debug!("Taking linters: {:?}", taken_linters);
        linters = linters
            .into_iter()
            .filter(|linter| taken_linters.contains(&linter.code))
            .collect();
    }

    // Apply --skip
    if let Some(skipped_linters) = skipped_linters {
        debug!("Skipping linters: {:?}", skipped_linters);
        linters = linters
            .into_iter()
            .filter(|linter| !skipped_linters.contains(&linter.code))
            .collect();
    }
    Ok(linters)
}

impl LintRunnerConfig {
    pub fn new(path: &AbsPath) -> Result<LintRunnerConfig> {
        let path = path.as_pathbuf();
        let lint_config = fs::read_to_string(path.as_path())
            .context(format!("Failed to read config file: '{}'.", path.display()))?;
        let config: LintRunnerConfig = toml::from_str(&lint_config).context(format!(
            "Config file '{}' had invalid schema",
            path.display()
        ))?;
        for linter in &config.linters {
            if let Some(init_args) = &linter.init_command {
                if init_args.iter().all(|arg| !arg.contains("{{DRYRUN}}")) {
                    bail!(
                        "Config for linter {} defines init args \
                         but does not take a {{{{DRYRUN}}}} argument.",
                        linter.code
                    );
                }
            }
        }

        Ok(config)
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
