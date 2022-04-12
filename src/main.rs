use std::{collections::HashSet, convert::TryFrom, io::Write};

use anyhow::{Context, Result};
use structopt::StructOpt;

use lintrunner::{
    do_init, do_lint, lint_config::get_linters_from_config, path::AbsPath, render::print_error,
    PathsToLint,
};

#[derive(Debug, StructOpt)]
#[structopt(name = "lintrunner", about = "A lint runner")]
struct Opt {
    /// Verbose mode (-v, or -vv to show full list of paths being linted)
    #[structopt(short, long, parse(from_occurrences))]
    verbose: u8,

    /// Path to a toml file defining which linters to run
    #[structopt(long, default_value = ".lintrunner.toml")]
    config: String,

    /// If set, any suggested patches will be applied
    #[structopt(short, long)]
    apply_patches: bool,

    /// Shell command that returns new-line separated paths to lint
    /// (e.g. --paths-cmd 'git ls-files path/to/project')
    #[structopt(long, conflicts_with = "paths-from")]
    paths_cmd: Option<String>,

    /// File with new-line separated paths to lint
    #[structopt(long)]
    paths_from: Option<String>,

    /// Lint all files that differ between the working directory and the
    /// specified revision. This argument can be any <tree-ish> that is accepted
    /// by `git diff-tree`
    #[structopt(long, conflicts_with_all=&["paths", "paths-cmd", "paths-from"])]
    revision: Option<String>,

    /// Comma-separated list of linters to skip (e.g. --skip CLANGFORMAT,NOQA)
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

    /// Paths to lint.
    #[structopt(conflicts_with_all = &["paths-cmd", "paths-from"])]
    paths: Vec<String>,

    /// If set, always output with ANSI colors, even if we detect the output is
    /// not a user-attended terminal.
    #[structopt(long, conflicts_with = "json")]
    force_color: bool,
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

fn do_main() -> Result<i32> {
    let opt = Opt::from_args();
    if opt.force_color {
        console::set_colors_enabled(true);
        console::set_colors_enabled_stderr(true);
    }
    let log_level = match (opt.verbose, opt.json) {
        // Default
        (0, false) => log::LevelFilter::Info,
        // If just json is asked for, suppress most output except hard errors.
        (0, true) => log::LevelFilter::Error,

        // Verbose overrides json.
        (1, false) => log::LevelFilter::Debug,
        (1, true) => log::LevelFilter::Debug,

        // Any higher verbosity goes to trace.
        (_, _) => log::LevelFilter::Trace,
    };
    env_logger::Builder::new().filter_level(log_level).init();

    let config_path = AbsPath::try_from(&opt.config)
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

    let enable_spinners = opt.verbose == 0 && !opt.json;

    let paths_to_lint = if let Some(paths_file) = opt.paths_from {
        let path_file = AbsPath::try_from(&paths_file)
            .with_context(|| format!("Failed to find `--paths-from` file '{}'", paths_file))?;
        PathsToLint::PathsFile(path_file)
    } else if let Some(paths_cmd) = opt.paths_cmd {
        PathsToLint::PathsCmd(paths_cmd)
    } else if !opt.paths.is_empty() {
        PathsToLint::Paths(opt.paths)
    } else {
        PathsToLint::Auto
    };

    match opt.cmd {
        Some(SubCommand::Init { dry_run }) => {
            // Just run initialization commands, don't actually lint.
            do_init(linters, dry_run)
        }
        None => {
            // Default command is to just lint.
            do_lint(
                linters,
                paths_to_lint,
                opt.apply_patches,
                opt.json,
                enable_spinners,
                opt.revision,
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
    drop(std::io::stdout().flush());
    drop(std::io::stderr().flush());

    // exit() abruptly ends the process while running no destructors. We should
    // make sure that nothing is alive before running this.
    std::process::exit(code);
}
