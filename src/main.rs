use anyhow::{bail, Context, Result};
use console::{style, Term};
use indicatif::{MultiProgress, ProgressBar};
use lint_config::get_linters_from_config;
use linter::Linter;
use log::debug;
use path::AbsPath;
use render::{print_error, render_lint_messages, render_lint_messages_json};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::{collections::HashSet, process::Command};
use std::{io, thread};
use structopt::StructOpt;

mod lint_config;
mod lint_message;
mod linter;
mod path;
mod render;

use lint_message::LintMessage;
use render::PrintedLintErrors;

fn get_paths_cmd_files(paths_cmd: String) -> Result<Vec<AbsPath>> {
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

fn get_changed_files() -> Result<Vec<AbsPath>> {
    // Retrieve changed files in current commit.
    // But only if that commit isn't a "public" commit (e.g. is part of the
    // remote's default branch).
    let mut commit_files: Option<HashSet<String>> = None;
    if !is_head_public()? {
        let output = Command::new("git")
            .arg("diff-tree")
            .arg("--no-commit-id")
            .arg("--name-only")
            .arg("-r")
            .arg("HEAD")
            .output()?;
        if !output.status.success() {
            bail!("Failed to determine files to lint; git diff-tree failed");
        }

        let commit_files_str = std::str::from_utf8(&output.stdout)?;

        commit_files = Some(
            commit_files_str
                .split("\n")
                .map(|x| x.to_string())
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
        .map(|f| AbsPath::new(PathBuf::from(f)))
        .collect::<Result<_>>()
}

fn group_lints_by_file(
    all_lints: &mut HashMap<Option<AbsPath>, Vec<LintMessage>>,
    lints: Vec<LintMessage>,
) {
    lints.into_iter().fold(all_lints, |acc, lint| {
        acc.entry(lint.path.clone())
            .or_insert_with(Vec::new)
            .push(lint);
        acc
    });
}

fn apply_patches(lint_messages: &Vec<LintMessage>) -> Result<()> {
    let mut patched_paths = HashSet::new();
    for lint_message in lint_messages {
        if let (Some(replacement), Some(path)) = (&lint_message.replacement, &lint_message.path) {
            if patched_paths.contains(path.as_pathbuf().as_path()) {
                bail!(
                    "Two different linters proposed changes for the same file:
                    {}.\n This is not yet supported, file an issue if you want it.",
                    path.as_pathbuf().display()
                );
            }
            patched_paths.insert(path.as_pathbuf().as_path());

            std::fs::write(path.as_pathbuf(), replacement).context(format!(
                "Failed to write apply patch to file: '{}'",
                path.as_pathbuf().display()
            ))?;
        }
    }
    Ok(())
}

#[derive(Debug, StructOpt)]
#[structopt(name = "lintrunner", about = "A lint runner")]
struct Opt {
    #[structopt(short, long)]
    verbose: bool,

    /// Path to a toml file defining which linters to run
    #[structopt(long, default_value = ".lintrunner.toml")]
    config: String,

    /// If set, any suggested patches will be applied
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

    /// If set, lintrunner will render lint messages as JSON, according to the
    /// LintMessage spec.
    #[structopt(long)]
    json: bool,

    #[structopt(subcommand)]
    cmd: Option<SubCommand>,
}

#[derive(StructOpt, Debug)]
enum SubCommand {
    /// Perform first-time setup for linters
    Init {
        /// If set, do not actually execute initialization commands, just print them
        #[structopt(long, short)]
        dry_run: bool,
    },
}

fn do_init(linters: Vec<Linter>, dry_run: bool) -> Result<i32> {
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

fn do_lint(
    linters: Vec<Linter>,
    paths_cmd: Option<String>,
    should_apply_patches: bool,
    render_as_json: bool,
    enable_spinners: bool,
) -> Result<i32> {
    debug!(
        "Running linters: {:?}",
        linters.iter().map(|l| &l.code).collect::<Vec<_>>()
    );

    // Too lazy to learn rust's fancy concurrent programming stuff, just spawn a thread per linter and join them.
    let all_lints = Arc::new(Mutex::new(HashMap::new()));
    let files = match paths_cmd {
        Some(paths_cmd) => get_paths_cmd_files(paths_cmd)?,
        None => get_changed_files()?,
    };
    let files = Arc::new(files);

    debug!("Linting files: {:#?}", files);

    let mut thread_handles = Vec::new();
    let spinners = Arc::new(MultiProgress::new());

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

            let lints = linter.run(&files)?;

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

fn do_main() -> Result<i32> {
    let opt = Opt::from_args();
    let log_level = match (opt.verbose, opt.json) {
        // Verbose overrides json
        (true, true) => log::LevelFilter::Debug,
        (true, false) => log::LevelFilter::Debug,
        // If just json is asked for, suppress most output except hard errors.
        (false, true) => log::LevelFilter::Error,
        // Default
        (false, false) => log::LevelFilter::Info,
    };
    env_logger::Builder::new().filter_level(log_level).init();

    let config_path = AbsPath::new(PathBuf::from(&opt.config))
        .with_context(|| format!("Could not read lintrunner config at: '{}'", opt.config))?;
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

    let enable_spinners = !opt.verbose && !opt.json;

    match opt.cmd {
        Some(SubCommand::Init { dry_run }) => {
            // Just run initialization commands, don't actually lint.
            do_init(linters, dry_run)
        }
        None => {
            // Default command is to just lint.
            do_lint(
                linters,
                opt.paths_cmd,
                opt.apply_patches,
                opt.json,
                enable_spinners,
            )
        }
    }
}

fn main() {
    let code = match do_main() {
        Ok(code) => code,
        Err(err) => {
            print_error(&err)
                .context("failed to print exit error")
                .unwrap();
            1
        }
    };

    // Flush the output before exiting, in case there is anything left in the buffers.
    drop(io::stdout().flush());
    drop(io::stderr().flush());

    // exit() abruptly ends the process while running no destructors. We should
    // make sure that nothing is alive before running this.
    std::process::exit(code);
}
