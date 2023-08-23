use std::io::Write;
use std::path::Path;
use std::process::Command;

use crate::{
    lint_message::LintMessage,
    log_utils::{ensure_output, log_files},
    path::{path_relative_from, AbsPath},
};
use anyhow::{anyhow, bail, ensure, Context, Result};
use glob::{MatchOptions, Pattern};
use log::{debug, info};

pub struct Linter {
    pub code: String,
    pub include_patterns: Vec<Pattern>,
    pub exclude_patterns: Vec<Pattern>,
    pub commands: Vec<String>,
    pub init_commands: Option<Vec<String>>,
    pub primary_config_path: AbsPath,
}

fn matches_relative_path(base: &Path, from: &Path, pattern: &Pattern) -> bool {
    // Unwrap ok because we already checked that both paths are absolute.
    let relative_path = path_relative_from(from, base).unwrap();
    pattern.matches_with(
        relative_path.to_str().unwrap(),
        MatchOptions {
            case_sensitive: true,
            // Explicitly set this option to true. Most unix implementations do
            // not allow `*` to match across path segments, so the default
            // (false) behavior is unexpected for people.
            require_literal_separator: true,
            require_literal_leading_dot: false,
        },
    )
}

impl Linter {
    pub fn get_config_dir(&self) -> &Path {
        // Unwrap is fine here because we know this path is absolute and won't be `/`
        self.primary_config_path.parent().unwrap()
    }

    fn get_matches(&self, files: &[AbsPath]) -> Vec<AbsPath> {
        let config_dir = self.get_config_dir();
        files
            .iter()
            .filter(|name| {
                self.include_patterns
                    .iter()
                    .any(|pattern| matches_relative_path(config_dir, name, pattern))
            })
            .filter(|name| {
                !self
                    .exclude_patterns
                    .iter()
                    .any(|pattern| matches_relative_path(config_dir, name, pattern))
            })
            .cloned()
            .collect()
    }

    fn run_command(&self, matched_files: Vec<AbsPath>) -> Result<Vec<LintMessage>> {
        let tmp_file = tempfile::NamedTempFile::new()?;
        for matched_file in &matched_files {
            let name = matched_file
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
            arguments
                .iter()
                .map(|x| format!("'{x}'"))
                .collect::<Vec<_>>()
                .join(" ")
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
        ensure_output("Linter command", &command)?;

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
        let mut messages = Vec::new();
        for line in stdout_str.lines() {
            if line.is_empty() {
                continue;
            }
            let msg = serde_json::from_str(line).with_context(|| {
                format!(
                    "Failed to deserialize output for lint adapter, line: {}",
                    line
                )
            })?;
            messages.push(msg);
        }
        Ok(messages)
    }

    pub fn run(&self, files: &[AbsPath]) -> Vec<LintMessage> {
        let matches = self.get_matches(files);
        log_files(&format!("Linter '{}' matched files: ", self.code), &matches);
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
                vec![err_lint]
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
                info!("the init commands are {:?}", init_commands);
                let (program, arguments) = init_commands.split_at(1);
                debug!(
                    "Running: {} {}",
                    program[0],
                    arguments
                        .iter()
                        .map(|i| format!("'{i}'"))
                        .collect::<Vec<_>>()
                        .join(" ")
                );
                let status = Command::new(&program[0])
                    .args(arguments)
                    .current_dir(self.get_config_dir())
                    .status()?;
                info!("the status is {:?}", status);
                ensure!(
                    status.success(),
                    "lint initializer for '{}' failed with non-zero exit code",
                    self.code
                );
                Ok(())
            }
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    // Check that `*` does not match across path segments.
    #[test]
    fn test_glob_with_separator() -> Result<()> {
        assert!(!matches_relative_path(
            &PathBuf::from(""),
            &PathBuf::from("foo/bar/baz"),
            &Pattern::new("foo/b*")?,
        ));
        Ok(())
    }
}
