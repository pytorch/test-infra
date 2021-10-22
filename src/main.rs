use anyhow::{Context, Result};
use glob::Pattern;
use log::debug;
use render::render_lint_messages;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::exit;
use std::sync::{Arc, Mutex};
use std::thread;
use std::{collections::HashSet, process::Command};
use structopt::StructOpt;

mod lint_config;
mod lint_message;
mod linter;
mod render;

use lint_config::LintConfig;
use lint_message::LintMessage;
use render::PrintedLintErrors;

fn get_changed_files() -> Result<Vec<String>> {
    // Retrieve changed files in current commit
    let commit_files = Command::new("git")
        .arg("diff-tree")
        .arg("--no-commit-id")
        .arg("--name-only")
        .arg("-r")
        .arg("HEAD")
        .output()?;

    let commit_files_str = std::str::from_utf8(&commit_files.stdout)?;

    let commit_files: HashSet<String> = commit_files_str
        .split("\n")
        .map(|x| x.to_string())
        .filter(|line| !line.is_empty())
        .collect();

    // Retrieve changed files in the working tree
    let working_tree_files = Command::new("git")
        .arg("diff-index")
        .arg("--no-commit-id")
        .arg("--name-only")
        .arg("-r")
        .arg("HEAD")
        .output()?;

    let working_tree_files_str = std::str::from_utf8(&working_tree_files.stdout)?;
    let working_tree_files: HashSet<String> = working_tree_files_str
        .split("\n")
        .map(|x| x.to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let mut all_changed_files: Vec<String> = commit_files
        .union(&working_tree_files)
        .map(|x| x.clone())
        .collect();

    // Sort for consistency
    all_changed_files.sort();
    Ok(all_changed_files)
}

fn write_matches_to_file(matched_files: Vec<String>) -> Result<tempfile::NamedTempFile> {
    let file = tempfile::NamedTempFile::new()?;
    for matched_file in matched_files {
        writeln!(&file, "{}", matched_file)?;
    }
    Ok(file)
}

fn group_lints_by_file(
    all_lints: &mut HashMap<PathBuf, Vec<LintMessage>>,
    lints: Vec<LintMessage>,
) {
    lints.into_iter().fold(all_lints, |acc, lint| {
        acc.entry(PathBuf::from(lint.path.clone()))
            .or_insert_with(Vec::new)
            .push(lint);
        acc
    });
}

struct Linter {
    name: String,
    patterns: Vec<Pattern>,
    commands: Vec<String>,
}

impl Linter {
    fn get_matches(&self, files: &Vec<String>) -> Vec<String> {
        files
            .iter()
            .filter(|name| self.patterns.iter().any(|pattern| pattern.matches(name)))
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

        debug!("Running: {} {}", program[0], arguments.join(" "));
        let command = Command::new(&program[0]).args(arguments).output()?;

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

    fn run(&self, files: &Vec<String>) -> Result<Vec<LintMessage>> {
        let matches = self.get_matches(files);
        debug!("Linter '{}' matched files: {:#?}", self.name, matches);
        if matches.is_empty() {
            return Ok(Vec::new());
        }
        let file = write_matches_to_file(matches)?;
        self.run_command(file)
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

fn apply_patches(lint_messages: &HashMap<PathBuf, Vec<LintMessage>>) -> Result<()> {
    for (path, lint_messages) in lint_messages {
        for lint_message in lint_messages {
            if let Some(replacement) = &lint_message.replacement {
                std::fs::write(path, replacement).context(format!(
                    "Failed to write apply patch to file: '{}'",
                    path.display()
                ))?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, StructOpt)]
#[structopt(name = "example", about = "An example of StructOpt usage.")]
struct Opt {
    #[structopt(long = "config", default_value = ".lintrunner.toml")]
    config: String,

    #[structopt(short = "v", long = "verbose")]
    verbose: bool,

    #[structopt(short = "a", long = "apply-patches")]
    apply_patches: bool,
}

fn main() -> Result<()> {
    let opt = Opt::from_args();
    let log_level = if opt.verbose {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    env_logger::Builder::new().filter_level(log_level).init();

    let config_path = PathBuf::from(opt.config);
    let lint_config = LintConfig::new(&config_path)?;

    let mut linters = Vec::new();
    for config in lint_config.linters {
        let patterns = patterns_from_strs(&config.patterns)?;
        linters.push(Linter {
            name: config.name,
            patterns,
            commands: config.args,
        });
    }

    // Too lazy to learn rust's fancy concurrent programming stuff, just spawn a thread per linter and join them.
    let all_lints = Arc::new(Mutex::new(HashMap::new()));
    let files = Arc::new(get_changed_files()?);

    debug!("Linting files: {:#?}", files);

    let mut thread_handles = Vec::new();

    for linter in linters {
        let all_lints = Arc::clone(&all_lints);
        let files = Arc::clone(&files);
        let handle = thread::spawn(move || -> Result<()> {
            let lints = linter.run(&files)?;
            let mut all_lints = all_lints.lock().unwrap();
            group_lints_by_file(&mut all_lints, lints);
            Ok(())
        });
        thread_handles.push(handle);
    }

    for handle in thread_handles {
        handle.join().unwrap()?;
    }

    let all_lints = all_lints.lock().unwrap();
    let did_print = render_lint_messages(&all_lints)?;
    match did_print {
        PrintedLintErrors::No => {
            exit(0);
        }
        PrintedLintErrors::Yes => {
            if opt.apply_patches {
                apply_patches(&all_lints)?;
            }
            exit(1);
        }
    }
}
