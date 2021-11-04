use std::io::Write;
use std::path::Path;
use std::process::Command;

use crate::{
    lint_message::LintMessage,
    path::{path_relative_from, AbsPath},
};
use anyhow::{bail, Context, Result};
use glob::Pattern;
use log::{debug, info};

pub struct Linter {
    pub name: String,
    pub include_patterns: Vec<Pattern>,
    pub exclude_patterns: Vec<Pattern>,
    pub commands: Vec<String>,
    pub init_commands: Option<Vec<String>>,
    pub config_path: AbsPath,
    pub bypass_matched_file_filter: bool,
}

fn matches_relative_path(base: &Path, from: &Path, pattern: &Pattern) -> bool {
    // Unwrap ok because we already checked that both paths are absolute.
    let relative_path = path_relative_from(from, base).unwrap();
    pattern.matches(relative_path.to_str().unwrap())
}

impl Linter {
    fn get_matches(&self, files: &Vec<AbsPath>) -> Vec<AbsPath> {
        // Unwrap is fine here because we know this path is absolute and won't be `/`
        let config_dir = self.config_path.as_pathbuf().parent().unwrap();

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
            .map(|p| p.clone())
            .collect()
    }

    fn run_command(&self, matched_files: Vec<AbsPath>) -> Result<Vec<LintMessage>> {
        let tmp_file = tempfile::NamedTempFile::new()?;
        for matched_file in &matched_files {
            let name = matched_file
                .as_pathbuf()
                .to_str()
                .ok_or(anyhow::Error::msg("Could not convert path to string."))?;
            writeln!(&tmp_file, "{}", name)?;
        }

        let file_path = tmp_file
            .path()
            .to_str()
            .ok_or(anyhow::Error::msg("tempfile corrupted"))?;

        let (program, arguments) = self.commands.split_at(1);
        let arguments: Vec<String> = arguments
            .iter()
            .map(|arg| arg.replace("{{PATHSFILE}}", file_path))
            .collect();

        debug!(
            "Running linter {}: {} {}",
            self.name,
            program[0],
            arguments.join(" ")
        );

        let start = std::time::Instant::now();
        let command = Command::new(&program[0]).args(arguments).output()?;
        debug!("Linter {} took: {:?}", self.name, start.elapsed());

        if !&command.status.success() {
            let stderr = std::str::from_utf8(&command.stderr)?.to_owned();
            return Err(anyhow::Error::msg(format!(
                "lint adapter for '{}' failed with non-zero exit code",
                self.name
            )))
            .with_context(|| stderr);
        }
        let stdout_str = std::str::from_utf8(&command.stdout)?;
        let lints = stdout_str
            .split("\n")
            .filter(|line| !line.is_empty())
            .map(|line| LintMessage::from_json(line))
            .collect::<Result<Vec<LintMessage>>>()
            .context(format!(
                "Failed to deserialize output for lint adapter: '{}'",
                self.name
            ))?;
        if self.bypass_matched_file_filter {
            Ok(lints)
        } else {
            Ok(lints
                .into_iter()
                .filter(|lint| {
                    if let Some(path) = &lint.path {
                        matched_files.contains(path)
                    } else {
                        // Always display lints without a path.
                        true
                    }
                })
                .collect())
        }
    }

    pub fn run(&self, files: &Vec<AbsPath>) -> Result<Vec<LintMessage>> {
        let matches = self.get_matches(&files);
        debug!("Linter '{}' matched files: {:#?}", self.name, matches);
        if matches.is_empty() {
            return Ok(Vec::new());
        }
        self.run_command(matches)
    }

    pub fn init(&self, dry_run: bool) -> Result<()> {
        match &self.init_commands {
            Some(init_commands) => {
                info!("Initializing linter: '{}'", self.name);
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
                let status = Command::new(&program[0]).args(arguments).status()?;
                if !status.success() {
                    bail!(
                        "lint initializer for '{}' failed with non-zero exit code",
                        self.name
                    );
                }
                Ok(())
            }
            None => Ok(()),
        }
    }
}
