use std::{collections::HashSet, fs};

use crate::{linter::Linter, path::AbsPath};
use anyhow::{bail, ensure, Context, Result};
use figment::{
    providers::{Format, Toml},
    Figment,
};
use glob::Pattern;
use log::debug;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct LintRunnerConfig {
    #[serde(rename = "linter")]
    pub linters: Vec<LintConfig>,

    /// The default value for the `merge_base_with` parameter.
    /// Recommend setting this is set to your default branch, e.g. `main`
    #[serde()]
    pub merge_base_with: Option<String>,

    /// If set, will only lint files under the directory where the configuration file is located and its subdirectories.
    /// Supercedes command line argument.
    #[serde()]
    pub only_lint_under_config_dir: Option<bool>,
}

fn is_false(b: &bool) -> bool {
    !(*b)
}

/// Represents a single linter, along with all the information necessary to invoke it.
///
/// This goes in the linter configuration TOML file.
///
/// # Examples:
///
/// ```toml
/// [[linter]]
/// code = 'NOQA'
/// include_patterns = ['**/*.py', '**/*.pyi']
/// exclude_patterns = ['caffe2/**']
/// command = [
///     'python3',
///     'linters/check_noqa.py',
///     '--',
///     '@{{PATHSFILE}}'
/// ]
/// ```
#[derive(Serialize, Deserialize, Clone)]
pub struct LintConfig {
    /// The name of the linter, conventionally capitals and numbers, no spaces,
    /// dashes, or underscores
    ///
    /// # Examples
    /// - `'FLAKE8'`
    /// - `'CLANGFORMAT'`
    pub code: String,

    /// A list of UNIX-style glob patterns. Paths matching any of these patterns
    /// will be linted. Patterns should be specified relative to the location
    /// of the config file.
    ///
    /// # Examples
    /// - Matching against everything:
    /// ```toml
    /// include_patterns = ['**']
    /// ```
    /// - Matching against a specific file extension:
    /// ```toml
    /// include_patterns = ['include/**/*.h', 'src/**/*.cpp']
    /// ```
    /// - Match a specific file:
    /// ```toml
    /// include_patterns = ['include/caffe2/caffe2_operators.h', 'torch/csrc/jit/script_type.h']
    /// ```
    pub include_patterns: Vec<String>,

    /// A list of UNIX-style glob patterns. Paths matching any of these patterns
    /// will be never be linted, even if they match an include pattern.
    ///
    /// For examples, see: [`LintConfig::include_patterns`]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_patterns: Option<Vec<String>>,

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
    /// Commands are run with the current working directory set to the parent
    /// directory of the config file.
    ///
    /// # Examples
    /// - Calling a Python script:
    /// ```toml
    /// command = ['python3', 'my_linter.py', '--', '@{{PATHSFILE}}']
    /// ```
    pub command: Vec<String>,

    /// A list of arguments describing how to set up the right dependencies for
    /// this linter. This command will be run when `lintrunner init` is called.
    ///
    /// The string `{{DRYRUN}}` must be present in the arguments provided. It
    /// will be 1 if `lintrunner init --dry-run` is called, 0 otherwise.
    ///
    /// If `{{DRYRUN}}` is set, this command is expected to not make any changes
    /// to the user's environment, instead it should only print what it will do.
    ///
    /// Commands are run with the current working directory set to the parent
    /// directory of the config file.
    ///
    /// # Examples
    /// - Calling a Python script:
    /// ```toml
    /// init_command = ['python3', 'my_linter_init.py', '--dry-run={{DRYRUN}}']
    /// ```
    pub init_command: Option<Vec<String>>,

    /// If true, this linter will be considered a formatter, and will invoked by
    /// `lintrunner format`. Formatters should be *safe*: people should be able
    /// to blindly accept the output without worrying that it will change the
    /// meaning of their code.
    #[serde(skip_serializing_if = "is_false", default = "bool::default")]
    pub is_formatter: bool,
}

/// Given options specified by the user, return a list of linters to run.
pub fn get_linters_from_configs(
    linter_configs: &[LintConfig],
    skipped_linters: Option<HashSet<String>>,
    taken_linters: Option<HashSet<String>>,
    primary_config_path: &AbsPath,
) -> Result<Vec<Linter>> {
    let mut linters = Vec::new();
    let mut all_linters: HashSet<String> = HashSet::new();

    for lint_config in linter_configs {
        if all_linters.contains(&lint_config.code) {
            bail!(
                "Invalid linter configuration: linter '{}' is defined multiple times.",
                lint_config.code
            );
        }
        all_linters.insert(lint_config.code.clone());

        let include_patterns = patterns_from_strs(&lint_config.include_patterns)?;
        let exclude_patterns = if let Some(exclude_patterns) = &lint_config.exclude_patterns {
            patterns_from_strs(exclude_patterns)?
        } else {
            Vec::new()
        };

        ensure!(
            !lint_config.command.is_empty(),
            "Invalid linter configuration: '{}' has an empty command list.",
            lint_config.code
        );

        linters.push(Linter {
            code: lint_config.code.clone(),
            include_patterns,
            exclude_patterns,
            commands: lint_config.command.clone(),
            init_commands: lint_config.init_command.clone(),
            primary_config_path: primary_config_path.clone(),
        });
    }

    debug!("Found linters: {:?}", all_linters);

    // Apply --take
    if let Some(taken_linters) = taken_linters {
        debug!("Taking linters: {:?}", taken_linters);
        for linter in &taken_linters {
            ensure!(
                all_linters.contains(linter),
                "Unknown linter specified in --take: {}. These linters are available: {:?}",
                linter,
                all_linters,
            );
        }

        linters.retain(|linter| taken_linters.contains(&linter.code));
    }

    // Apply --skip
    if let Some(skipped_linters) = skipped_linters {
        debug!("Skipping linters: {:?}", skipped_linters);
        for linter in &skipped_linters {
            ensure!(
                all_linters.contains(linter),
                "Unknown linter specified in --skip: {}. These linters are available: {:?}",
                linter,
                all_linters,
            );
        }
        linters.retain(|linter| !skipped_linters.contains(&linter.code));
    }
    Ok(linters)
}

impl LintRunnerConfig {
    pub fn new(paths: &Vec<std::string::String>) -> Result<LintRunnerConfig> {
        let mut config = Figment::new();
        for path in paths {
            let config_str = fs::read_to_string(path)
                .context(format!("Could not read config file at {}", path))?;

            // schema check
            let _test_str = toml::from_str::<toml::Value>(&config_str)
                .context(format!("Config file at {} had invalid schema", path))?;

            config = config.merge(Toml::file(path));
        }

        let config = config
            .extract::<LintRunnerConfig>()
            .context("Config file had invalid schema")?;

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

fn patterns_from_strs(pattern_strs: &[String]) -> Result<Vec<Pattern>> {
    pattern_strs
        .iter()
        .map(|pattern_str| {
            Pattern::new(pattern_str).map_err(|err| {
                anyhow::Error::msg(err)
                    .context("Could not parse pattern from linter configuration.")
            })
        })
        .collect()
}
