use std::{collections::HashSet, path::PathBuf, process::Command};

use crate::path::AbsPath;
use anyhow::{Context, Result, bail};
use log::debug;
use regex::Regex;

pub fn get_paths_cmd_files(paths_cmd: String) -> Result<Vec<AbsPath>> {
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
    files
        .into_iter()
        .map(|f| AbsPath::new(PathBuf::from(f)))
        .collect::<Result<_>>()
}

fn is_head_public() -> Result<bool> {
    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("origin/HEAD")
        .output()?;
    if !output.status.success() {
        bail!("Failed to determine whether commit was public; git rev-parse failed");
    }
    let default_branch = std::str::from_utf8(&output.stdout)?.trim();
    let status = Command::new("git")
        .arg("merge-base")
        .arg("--is-ancestor")
        .arg("HEAD")
        .arg(default_branch)
        .status()?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => bail!("Failed to determine whether commit was public; git merge-base failed"),
    }
}

pub fn get_changed_files() -> Result<Vec<AbsPath>> {
    // Retrieve changed files in current commit.
    // But only if that commit isn't a "public" commit (e.g. is part of the
    // remote's default branch).
    let mut commit_files: Option<HashSet<String>> = None;
    if !is_head_public()? {
        let output = Command::new("git")
            .arg("diff-tree")
            .arg("--no-commit-id")
            .arg("--name-status")
            .arg("-r")
            .arg("HEAD")
            .output()?;
        if !output.status.success() {
            bail!("Failed to determine files to lint; git diff-tree failed");
        }

        // Output looks like:
        // D    src/lib.rs
        // M    foo/bar.baz
        let commit_files_str = std::str::from_utf8(&output.stdout)?;
        let re = Regex::new(r"^[A-Z]\s+")?;

        commit_files = Some(
            commit_files_str
                .split('\n')
                .map(|x| x.to_string())
                // Filter out deleted files.
                .filter(|line| !line.starts_with('D'))
                // Strip the status prefix.
                .map(|line| re.replace(&line, "").to_string())
                .filter(|line| !line.is_empty())
                .collect(),
        );
        debug!(
            "HEAD commit is not public, linting commit diff files: {:?}",
            commit_files
        );
    }
    // Retrieve changed files in the working tree
    let output = Command::new("git")
        .arg("diff-index")
        .arg("--no-commit-id")
        .arg("--name-only")
        .arg("-r")
        .arg("HEAD")
        .output()?;
    if !output.status.success() {
        bail!("Failed to determine files to lint; git diff-index failed");
    }

    let working_tree_files_str = std::str::from_utf8(&output.stdout)?;
    let working_tree_files: HashSet<String> = working_tree_files_str
        .lines()
        .filter(|line| !line.is_empty())
        .map(|x| x.to_string())
        .collect();

    debug!("Linting working tree diff files: {:?}", working_tree_files);
    let mut all_changed_files = working_tree_files;
    if let Some(commit_files) = commit_files {
        for file in commit_files {
            all_changed_files.insert(file);
        }
    }
    // Sort for consistency
    let mut all_changed_files: Vec<String> = all_changed_files.into_iter().collect();
    all_changed_files.sort();
    all_changed_files
        .into_iter()
        .map(|f| {
            AbsPath::new(PathBuf::from(&f)).with_context(|| {
                format!("Failed to find file while gathering files to lint: {}", f)
            })
        })
        .collect::<Result<_>>()
}
