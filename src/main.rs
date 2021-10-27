use anyhow::{Context, Result};
use log::debug;
use render::render_lint_messages;
use std::collections::HashMap;
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

use lint_message::LintMessage;
use render::PrintedLintErrors;

use crate::lint_config::get_linters_from_config;

fn get_paths_cmd_files(paths_cmd: String) -> Result<Vec<String>> {
    debug!("Running paths_cmd: {}", paths_cmd);
    let output = Command::new("sh")
        .arg("-c")
        .arg(paths_cmd)
        .output()
        .context("failed to run provided paths_cmd")?;

    let files = std::str::from_utf8(&output.stdout).context("failed to parse paths_cmd output")?;
    let files = files
        .lines()
        .map(|s| s.to_string())
        .collect::<HashSet<String>>();
    let mut files = files.into_iter().collect::<Vec<String>>();
    files.sort();
    Ok(files)
}

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
        .lines()
        .filter(|line| !line.is_empty())
        .map(|x| x.to_string())
        .collect();
    let mut all_changed_files: Vec<String> = commit_files
        .union(&working_tree_files)
        .map(|x| x.clone())
        .collect();

    // Sort for consistency
    all_changed_files.sort();
    Ok(all_changed_files)
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
    /// Path to a toml file defining which linters to run.
    #[structopt(long, default_value = ".lintrunner.toml")]
    config: String,

    #[structopt(short, long)]
    verbose: bool,

    /// If set, any suggested patches will be applied.
    #[structopt(short, long)]
    apply_patches: bool,

    /// Shell command that returns new-line separated paths to lint
    /// (e.g. --paths-cmd 'git ls-files path/to/project')
    #[structopt(long)]
    paths_cmd: Option<String>,

    /// Comma-separated list of linters to skip (e.g. --skip CLANGFORMAT,NOQA")
    #[structopt(long)]
    skip: Option<String>,

    /// Comma-separated list of linters to run (opposite of --skip)
    #[structopt(long)]
    take: Option<String>,
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
    let skipped_linters = opt.skip.map(|linters| {
        linters
            .split(',')
            .map(|linter_name| linter_name.to_string())
            .collect::<HashSet<_>>()
    });
    let taken_linters = opt.take.map(|linters| {
        linters
            .split(',')
            .map(|linter_name| linter_name.to_string())
            .collect::<HashSet<_>>()
    });

    let linters = get_linters_from_config(&config_path, skipped_linters, taken_linters)?;

    debug!(
        "Running linters: {:?}",
        linters.iter().map(|l| &l.name).collect::<Vec<_>>()
    );

    // Too lazy to learn rust's fancy concurrent programming stuff, just spawn a thread per linter and join them.
    let all_lints = Arc::new(Mutex::new(HashMap::new()));
    let files = match opt.paths_cmd {
        Some(paths_cmd) => get_paths_cmd_files(paths_cmd)?,
        None => get_changed_files()?,
    };
    let files = Arc::new(files);

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
