use std::io::Write;
use std::process::Command;

use crate::lint_message::LintMessage;
use anyhow::{bail, Context, Result};
use glob::Pattern;
use log::{debug, info};

pub struct Linter {
    pub name: String,
    pub include_patterns: Vec<Pattern>,
    pub exclude_patterns: Vec<Pattern>,
    pub commands: Vec<String>,
    pub init_commands: Option<Vec<String>>,
}

impl Linter {
    fn get_matches(&self, files: &Vec<String>) -> Vec<String> {
        files
            .iter()
            .filter(|name| {
                self.include_patterns
                    .iter()
                    .any(|pattern| pattern.matches(name))
            })
            .filter(|name| {
                !self
                    .exclude_patterns
                    .iter()
                    .any(|pattern| pattern.matches(name))
            })
            .map(|name| name.clone())
            .collect()
    }

    fn run_command(&self, filenames_to_lint: tempfile::NamedTempFile) -> Result<Vec<LintMessage>> {
        let file_path = filenames_to_lint
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
        let lints: Vec<LintMessage> = stdout_str
            .split("\n")
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).map_err(|a| anyhow::Error::msg(a.to_string())))
            .collect::<Result<_>>()
            .context(format!(
                "Failed to deserialize output for lint adapter: '{}'",
                self.name
            ))?;

        Ok(lints)
    }

    pub fn run(&self, files: &Vec<String>) -> Result<Vec<LintMessage>> {
        let matches = self.get_matches(files);
        debug!("Linter '{}' matched files: {:#?}", self.name, matches);
        if matches.is_empty() {
            return Ok(Vec::new());
        }
        let file = write_matches_to_file(matches)?;
        self.run_command(file)
    }

    pub fn init(&self, dry_run: bool) -> Result<()> {
        match &self.init_commands {
            Some(init_commands) => {
                info!("Initializing linter: '{}'", self.name);
                if init_commands.is_empty() {
                    return Ok(());
                }

                let dry_run = if dry_run {
                    "1"
                } else {
                    "0"
                };

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

fn write_matches_to_file(matched_files: Vec<String>) -> Result<tempfile::NamedTempFile> {
    let file = tempfile::NamedTempFile::new()?;
    for matched_file in matched_files {
        writeln!(&file, "{}", matched_file)?;
    }
    Ok(file)
}
