use anyhow::Result;
use console::{style, Term};
use log::debug;

use crate::{lint_config::LintRunnerConfig, path::AbsPath, persistent_data::PersistentDataStore};

const CONFIG_DATA_NAME: &'static str = ".lintrunner.toml";

// Check whether or not the currently configured init commands are different
// from the last time we ran `init`, and warn the user if so.
pub fn check_init_changed(
    persistent_data_store: &PersistentDataStore,
    current_config: &LintRunnerConfig,
) -> Result<()> {
    let stderr = Term::stderr();

    debug!(
        "Checking data file '{}/{}' to see if config has changed",
        persistent_data_store.data_dir.display(),
        CONFIG_DATA_NAME
    );

    if !persistent_data_store.exists(CONFIG_DATA_NAME) {
        stderr.write_line(&format!(
            "{}",
            style(
                "WARNING: No previous init data found. If this is the first time you're \
                running lintrunner, you should run `lintrunner init`.",
            )
            .bold()
            .yellow(),
        ))?;
        return Ok(());
    }
    let config_data = persistent_data_store.load_string(CONFIG_DATA_NAME)?;
    let old_config = LintRunnerConfig::new_from_string(&config_data)?;

    let old_init_commands: Vec<_> = old_config.linters.iter().map(|l| &l.init_command).collect();
    let current_init_commands: Vec<_> = current_config
        .linters
        .iter()
        .map(|l| &l.init_command)
        .collect();

    if old_init_commands != current_init_commands {
        stderr.write_line(&format!(
            "{}",
            style(
                "WARNING: The init commands have changed since you last ran lintrunner. \
                You may need to run `lintrunner init`.",
            )
            .bold()
            .yellow(),
        ))?;
    }

    Ok(())
}

pub fn write_config(
    persistent_data_store: &PersistentDataStore,
    config_path: &AbsPath,
) -> Result<()> {
    debug!(
        "Writing used config to {}/{}",
        persistent_data_store.data_dir.display(),
        CONFIG_DATA_NAME
    );

    let config_contents = std::fs::read_to_string(config_path)?;
    persistent_data_store.store_string(CONFIG_DATA_NAME, &config_contents)?;

    Ok(())
}
