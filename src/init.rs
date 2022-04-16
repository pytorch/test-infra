use anyhow::Result;
use console::Term;
use log::debug;
use std::path::{Path, PathBuf};

use crate::{lint_config::LintRunnerConfig, path::AbsPath};

fn get_data_file(config_path: &AbsPath, data_path: &Path) -> Result<PathBuf> {
    // We store the old copy of the config in `data_dir/<hash of path>`
    let config_path_hash = blake3::hash(config_path.to_string_lossy().as_bytes()).to_string();
    let data_file = data_path.join(config_path_hash);
    Ok(data_file)
}

// Check whether or not the currently configured init commands are different
// from the last time we ran `init`, and warn the user if so.
pub fn check_init_changed(
    config_path: &AbsPath,
    data_path: &Path,
    current_config: &LintRunnerConfig,
) -> Result<()> {
    let stderr = Term::stderr();

    let data_file = get_data_file(config_path, data_path)?;
    debug!(
        "Checking data file {} to see if config has changed",
        data_file.display()
    );

    if !data_file.exists() {
        stderr.write_line(
            "No previous init data found. If this is the first time you're \
             running lintrunner, you should run `lintrunner init`",
        )?;
        return Ok(());
    }
    let data_file = AbsPath::try_from(data_file)?;

    let old_config = LintRunnerConfig::new(&data_file)?;

    let old_init_commands: Vec<_> = old_config.linters.iter().map(|l| &l.init_command).collect();
    let current_init_commands: Vec<_> = current_config
        .linters
        .iter()
        .map(|l| &l.init_command)
        .collect();

    if old_init_commands != current_init_commands {
        stderr.write_line(
            "The init commands have changed since you last ran lintrunner. \
             You may need to run `lintrunner init`",
        )?;
    }

    Ok(())
}

pub fn write_config(config_path: &AbsPath, data_path: &Path) -> Result<()> {
    let data_file = get_data_file(config_path, data_path)?;
    debug!("Writing used config to {}", data_file.display());

    let config_contents = std::fs::read_to_string(config_path)?;
    std::fs::write(data_file, config_contents)?;

    Ok(())
}
