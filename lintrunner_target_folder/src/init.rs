use crate::{lint_config::LintRunnerConfig, persistent_data::PersistentDataStore};
use anyhow::Result;
use console::{style, Term};

// Check whether or not the currently configured init commands are different
// from the last time we ran `init`, and warn the user if so.
pub fn check_init_changed(
    persistent_data_store: &PersistentDataStore,
    current_config: &LintRunnerConfig,
) -> Result<()> {
    let stderr = Term::stderr();

    let last_init = persistent_data_store.last_init()?;
    if last_init.is_none() {
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
    let last_init = last_init.unwrap();
    let old_config = LintRunnerConfig::new_from_string(&last_init)?;

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
