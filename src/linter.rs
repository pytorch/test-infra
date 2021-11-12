use std::io::Write;
use std::path::Path;
use std::process::Command;

use crate::{
    lint_message::LintMessage,
    path::{path_relative_from, AbsPath},
};
use anyhow::{anyhow, bail, Context, Result};
use glob::Pattern;
use log::{debug, info};

pub struct Linter {
    pub code: String,
    pub include_patterns: Vec<Pattern>,
    pub exclude_patterns: Vec<Pattern>,
    pub commands: Vec<String>,
    pub init_commands: Option<Vec<String>>,
    pub config_path: AbsPath,
}

fn matches_relative_path(base: &Path, from: &Path, pattern: &Pattern) -> bool {
    // Unwrap ok because we already checked that both paths are absolute.
    let relative_path = path_relative_from(from, base).unwrap();
    pattern.matches(relative_path.to_str().unwrap())
}

impl Linter {
    fn get_config_dir(&self) -> &Path {
        // Unwrap is fine here because we know this path is absolute and won't be `/`
        self.config_path.as_pathbuf().parent().unwrap()
    }

    fn get_matches(&self, files: &[AbsPath]) -> Vec<AbsPath> {
        let config_dir = self.get_config_dir();
        files
            .iter()
            .filter(|name| {
                self.include_patterns.iter().any(|pattern| {
                    matches_relative_path(config_dir, name.as_pathbuf().as_path(), pattern)
                })
            })
            .filter(|name| {
                !self.exclude_patterns.iter().any(|pattern| {
                    matches_relative_path(config_dir, name.as_pathbuf().as_path(), pattern)
                })
            })
            .cloned()
            .collect()
    }

    fn run_command(&self, matched_files: Vec<AbsPath>) -> Result<Vec<LintMessage>> {
        let tmp_file = tempfile::NamedTempFile::new()?;
        for matched_file in &matched_files {
            let name = matched_file
                .as_pathbuf()
                .to_str()
                .ok_or_else(|| anyhow!("Could not convert path to string."))?;
            writeln!(&tmp_file, "{}", name)?;
        }

        let file_path = tmp_file
            .path()
            .to_str()
            .ok_or_else(|| anyhow!("tempfile corrupted"))?;

        let (program, arguments) = self.commands.split_at(1);
        let arguments: Vec<String> = arguments
            .iter()
            .map(|arg| arg.replace("{{PATHSFILE}}", file_path))
            .collect();

        debug!(
            "Running linter {}: {} {}",
            self.code,
            program[0],
            arguments.join(" ")
        );

        let start = std::time::Instant::now();
        let command = Command::new(&program[0])
            .args(&arguments)
            .current_dir(self.get_config_dir())
            .output()
            .with_context(|| {
                format!(
                    "Failed to execute linter command {} with args: {:?}",
                    program[0], arguments
                )
            })?;
        debug!("Linter {} took: {:?}", self.code, start.elapsed());

        if !&command.status.success() {
            let stderr = std::str::from_utf8(&command.stderr)?;
            let stdout = std::str::from_utf8(&command.stdout)?;
            bail!(
                "Linter command failed with non-zero exit code.\n\
                 STDERR:\n{}\n\nSTDOUT:{}\n",
                stderr,
                stdout,
            );
        }
        let stdout_str = std::str::from_utf8(&command.stdout)?;
        stdout_str
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).map_err(|a| anyhow::Error::msg(a.to_string())))
            .collect::<Result<Vec<LintMessage>>>()
            .context(format!(
                "Failed to deserialize output for lint adapter: '{}'",
                self.code
            ))
    }

    pub fn run(&self, files: &[AbsPath]) -> Vec<LintMessage> {
        let matches = self.get_matches(&files);
        debug!("Linter '{}' matched files: {:#?}", self.code, matches);
        if matches.is_empty() {
            return Vec::new();
        }
        // Wrap the command in a Result to ensure uniform error handling.
        // This way, linters are guaranteed to exit cleanly, and any issue will
        // be reported using the same mechanism that we use to report regular
        // lint errors.
        match self.run_command(matches) {
            Err(e) => {
                let err_lint = LintMessage {
                    path: None,
                    line: None,
                    char: None,
                    code: self.code.clone(),
                    severity: crate::lint_message::LintSeverity::Error,
                    name: "Linter failed".to_string(),
                    description: Some(format!(
                        "Linter failed. This a bug, please file an issue against \
                                 the linter maintainer.\n\nCONTEXT:\n{}",
                        e
                    )),
                    original: None,
                    replacement: None,
                };
                return vec![err_lint];
            }
            Ok(messages) => messages,
        }
    }

    pub fn init(&self, dry_run: bool) -> Result<()> {
        match &self.init_commands {
            Some(init_commands) => {
                info!("Initializing linter: '{}'", self.code);
                if init_commands.is_empty() {
                    return Ok(());
                }

                let dry_run = if dry_run { "1" } else { "0" };

                let init_commands: Vec<String> = init_commands
                    .iter()
                    .map(|arg| arg.replace("{{DRYRUN}}", dry_run))
                    .collect();
                let (program, arguments) = init_commands.split_at(1);
                debug!("Running: {} {}", program[0], arguments.join(" "));
                let status = Command::new(&program[0])
                    .args(arguments)
                    .current_dir(self.get_config_dir())
                    .status()?;
                if !status.success() {
                    bail!(
                        "lint initializer for '{}' failed with non-zero exit code",
                        self.code
                    );
                }
                Ok(())
            }
            None => Ok(()),
        }
    }
}
