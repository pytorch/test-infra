use anyhow::{bail, Context, Result};
use console::{style, Term};
use indicatif::{MultiProgress, ProgressBar};
use linter::Linter;
use log::debug;
use path::AbsPath;
use render::{render_lint_messages, render_lint_messages_json};
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

mod git;
mod log_utils;
pub mod lint_config;
pub mod lint_message;
pub mod linter;
pub mod path;
pub mod render;

use git::get_changed_files;
use git::get_git_root;
use git::get_paths_from_cmd;
use lint_message::LintMessage;
use render::PrintedLintErrors;

fn group_lints_by_file(
    all_lints: &mut HashMap<Option<String>, Vec<LintMessage>>,
    lints: Vec<LintMessage>,
) {
    lints.into_iter().fold(all_lints, |acc, lint| {
        acc.entry(lint.path.clone())
            .or_insert_with(Vec::new)
            .push(lint);
        acc
    });
}

fn apply_patches(lint_messages: &[LintMessage]) -> Result<()> {
    let mut patched_paths = HashSet::new();
    for lint_message in lint_messages {
        if let (Some(replacement), Some(path)) = (&lint_message.replacement, &lint_message.path) {
            let path = AbsPath::new(PathBuf::from(path))?;
            if patched_paths.contains(&path) {
                bail!(
                    "Two different linters proposed changes for the same file:
                    {}.\n This is not yet supported, file an issue if you want it.",
                    path.as_pathbuf().display()
                );
            }
            patched_paths.insert(path.clone());

            std::fs::write(path.as_pathbuf(), replacement).context(format!(
                "Failed to write apply patch to file: '{}'",
                path.as_pathbuf().display()
            ))?;
        }
    }
    Ok(())
}

pub fn do_init(linters: Vec<Linter>, dry_run: bool) -> Result<i32> {
    debug!(
        "Initializing linters: {:?}",
        linters.iter().map(|l| &l.code).collect::<Vec<_>>()
    );

    for linter in linters {
        linter.init(dry_run)?;
    }

    Ok(0)
}

fn remove_patchable_lints(lints: Vec<LintMessage>) -> Vec<LintMessage> {
    lints
        .into_iter()
        .filter(|lint| lint.replacement.is_none())
        .collect()
}

fn get_paths_from_input(paths: Vec<String>) -> Result<Vec<AbsPath>> {
    let mut ret = Vec::new();
    for path in &paths {
        let path = AbsPath::new(PathBuf::from(path))
            .with_context(|| format!("Failed to find provided file: '{}'", path))?;
        ret.push(path);
    }
    Ok(ret)
}

fn get_paths_from_file(file: AbsPath) -> Result<Vec<AbsPath>> {
    let file = std::fs::read_to_string(file.as_pathbuf()).with_context(|| {
        format!(
            "Failed to read file specified in `--paths-from`: '{}'",
            file.as_pathbuf().display()
        )
    })?;
    let files = file
        .trim()
        .lines()
        .map(|l| l.to_string())
        .collect::<Vec<String>>();
    get_paths_from_input(files)
}

pub enum PathsToLint {
    Auto,
    PathsFile(AbsPath),
    PathsCmd(String),
    Paths(Vec<String>),
}

pub fn do_lint(
    linters: Vec<Linter>,
    paths_to_lint: PathsToLint,
    should_apply_patches: bool,
    render_as_json: bool,
    enable_spinners: bool,
) -> Result<i32> {
    debug!(
        "Running linters: {:?}",
        linters.iter().map(|l| &l.code).collect::<Vec<_>>()
    );

    let mut files = match paths_to_lint {
        PathsToLint::Auto => {
            let git_root = get_git_root()?;
            get_changed_files(git_root)?
        }
        PathsToLint::PathsCmd(paths_cmd) => get_paths_from_cmd(paths_cmd)?,
        PathsToLint::Paths(paths) => get_paths_from_input(paths)?,
        PathsToLint::PathsFile(file) => get_paths_from_file(file)?,
    };

    // Sort and unique the files so we pass a consistent ordering to linters
    files.sort();
    files.dedup();

    let files = Arc::new(files);

    log_utils::log_files("Linting files: ", &files);

    let mut thread_handles = Vec::new();
    let spinners = Arc::new(MultiProgress::new());

    // Too lazy to learn rust's fancy concurrent programming stuff, just spawn a thread per linter and join them.
    let all_lints = Arc::new(Mutex::new(HashMap::new()));

    for linter in linters {
        let all_lints = Arc::clone(&all_lints);
        let files = Arc::clone(&files);
        let spinners = Arc::clone(&spinners);

        let handle = thread::spawn(move || -> Result<()> {
            let mut spinner = None;
            if enable_spinners {
                let _spinner = spinners.add(ProgressBar::new_spinner());
                _spinner.set_message(format!("{} running...", linter.code));
                _spinner.enable_steady_tick(100);
                spinner = Some(_spinner);
            }

            let lints = linter.run(&files);

            // If we're applying patches later, don't consider lints that would
            // be fixed by that.
            let lints = if should_apply_patches {
                apply_patches(&lints)?;
                remove_patchable_lints(lints)
            } else {
                lints
            };

            let mut all_lints = all_lints.lock().unwrap();
            let is_success = lints.is_empty();

            group_lints_by_file(&mut all_lints, lints);

            let spinner_message = if is_success {
                format!("{} {}", linter.code, style("success!").green())
            } else {
                format!("{} {}", linter.code, style("failure").red())
            };

            if enable_spinners {
                spinner.unwrap().finish_with_message(spinner_message);
            }
            Ok(())
        });
        thread_handles.push(handle);
    }

    spinners.join()?;
    for handle in thread_handles {
        handle.join().unwrap()?;
    }

    // Unwrap is fine because all other owners hsould have been joined.
    let all_lints = all_lints.lock().unwrap();

    let mut stdout = Term::stdout();

    let did_print = if render_as_json {
        render_lint_messages_json(&mut stdout, &all_lints)?
    } else {
        render_lint_messages(&mut stdout, &all_lints)?
    };

    if should_apply_patches {
        stdout.write_line("Successfully applied all patches.")?;
    }

    match did_print {
        PrintedLintErrors::No => Ok(0),
        PrintedLintErrors::Yes => Ok(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_paths_file() -> Result<()> {
        let file1 = NamedTempFile::new()?;
        let file2 = NamedTempFile::new()?;

        let mut paths_file = NamedTempFile::new()?;

        writeln!(paths_file, "{}", file1.path().display())?;
        writeln!(paths_file, "{}", file2.path().display())?;

        let paths_file = AbsPath::new(paths_file.path().to_path_buf())?;
        let paths = get_paths_from_file(paths_file)?;

        let file1_abspath = AbsPath::new(file1.path().to_path_buf())?;
        let file2_abspath = AbsPath::new(file2.path().to_path_buf())?;

        assert!(paths.contains(&file1_abspath));
        assert!(paths.contains(&file2_abspath));

        Ok(())
    }
}
