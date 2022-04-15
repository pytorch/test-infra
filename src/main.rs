use std::{collections::HashSet, convert::TryFrom, io::Write};

use anyhow::{Context, Result};
use clap::Parser;

use lintrunner::{
    do_init, do_lint, lint_config::get_linters_from_config, path::AbsPath, render::print_error,
    PathsToLint, RenderOpt, RevisionOpt,
};

#[derive(Debug, Parser)]
#[structopt(name = "lintrunner", about = "A lint runner")]
struct Args {
    /// Verbose mode (-v, or -vv to show full list of paths being linted)
    #[clap(short, long, parse(from_occurrences))]
    verbose: u8,

    /// Path to a toml file defining which linters to run
    #[clap(long, default_value = ".lintrunner.toml")]
    config: String,

    /// If set, any suggested patches will be applied
    #[clap(short, long)]
    apply_patches: bool,

    /// Shell command that returns new-line separated paths to lint
    ///
    /// Example: --paths-cmd 'git ls-files path/to/project'
    #[clap(long, conflicts_with = "paths-from")]
    paths_cmd: Option<String>,

    /// File with new-line separated paths to lint
    #[clap(long)]
    paths_from: Option<String>,

    /// Lint all files that differ between the working directory and the
    /// specified revision. This argument can be any <tree-ish> that is accepted
    /// by `git diff-tree`
    #[clap(long, short, conflicts_with_all=&["paths", "paths-cmd", "paths-from"])]
    revision: Option<String>,

    /// Lint all files that differ between the merge base of HEAD with the
    /// specified revision and HEAD. This argument can be any <tree-sh> that is
    /// accepted by `git diff-tree`
    ///
    /// Example: lintrunner -m master
    #[clap(long, short, conflicts_with_all=&["paths", "paths-cmd", "paths-from", "revision"])]
    merge_base_with: Option<String>,

    /// Comma-separated list of linters to skip (e.g. --skip CLANGFORMAT,NOQA)
    #[clap(long)]
    skip: Option<String>,

    /// Comma-separated list of linters to run (opposite of --skip)
    #[clap(long)]
    take: Option<String>,

    /// With 'default' show lint issues in human-readable format, for interactive use.
    /// With 'json', show lint issues as machine-readable JSON (one per line)
    /// With 'oneline', show lint issues in compact format (one per line)
    #[clap(long, arg_enum, default_value_t = RenderOpt::Default)]
    output: RenderOpt,

    #[clap(subcommand)]
    cmd: Option<SubCommand>,

    /// Paths to lint.
    #[clap(conflicts_with_all = &["paths-cmd", "paths-from"])]
    paths: Vec<String>,

    /// If set, always output with ANSI colors, even if we detect the output is
    /// not a user-attended terminal.
    #[clap(long)]
    force_color: bool,
}

#[derive(Debug, Parser)]
enum SubCommand {
    /// Perform first-time setup for linters
    Init {
        /// If set, do not actually execute initialization commands, just print them
        #[clap(long, short)]
        dry_run: bool,
    },
}

fn do_main() -> Result<i32> {
    let args = Args::parse();
    if args.force_color {
        console::set_colors_enabled(true);
        console::set_colors_enabled_stderr(true);
    }
    let log_level = match (args.verbose, args.output != RenderOpt::Default) {
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

    let config_path = AbsPath::try_from(&args.config)
        .with_context(|| format!("Could not read lintrunner config at: '{}'", args.config))?;
    let skipped_linters = args.skip.map(|linters| {
        linters
            .split(',')
            .map(|linter_name| linter_name.to_string())
            .collect::<HashSet<_>>()
    });
    let taken_linters = args.take.map(|linters| {
        linters
            .split(',')
            .map(|linter_name| linter_name.to_string())
            .collect::<HashSet<_>>()
    });

    let linters = get_linters_from_config(&config_path, skipped_linters, taken_linters)?;

    let enable_spinners = args.verbose == 0 && args.output == RenderOpt::Default;

    let paths_to_lint = if let Some(paths_file) = args.paths_from {
        let path_file = AbsPath::try_from(&paths_file)
            .with_context(|| format!("Failed to find `--paths-from` file '{}'", paths_file))?;
        PathsToLint::PathsFile(path_file)
    } else if let Some(paths_cmd) = args.paths_cmd {
        PathsToLint::PathsCmd(paths_cmd)
    } else if !args.paths.is_empty() {
        PathsToLint::Paths(args.paths)
    } else {
        PathsToLint::Auto
    };

    let revision_opt = if let Some(revision) = args.revision {
        RevisionOpt::Revision(revision)
    } else if let Some(merge_base_with) = args.merge_base_with {
        RevisionOpt::MergeBaseWith(merge_base_with)
    } else {
        RevisionOpt::Head
    };

    match args.cmd {
        Some(SubCommand::Init { dry_run }) => {
            // Just run initialization commands, don't actually lint.
            do_init(linters, dry_run)
        }
        None => {
            // Default command is to just lint.
            do_lint(
                linters,
                paths_to_lint,
                args.apply_patches,
                args.output,
                enable_spinners,
                revision_opt,
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
