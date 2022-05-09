//! Utilities to handle data that we want to persist across invocations of
//! lintrunner.
//!
//! This data will be placed in a platform specific location (unless overridden
//! by the user). To distinguish between different `.lintrunner.toml` configs,
//! we hash the absolute path to the config and include that as part of the
//! directory structure for persistent data.

use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use log::debug;
use std::path::{Path, PathBuf};

use crate::path::AbsPath;

const CONFIG_DATA_NAME: &str = ".lintrunner.toml";

/// Single way to interact with persistent data for a given run of lintrunner.
/// This is scoped to a single .lintrunner.toml config.
pub struct PersistentDataStore {
    data_dir: PathBuf,
}

impl PersistentDataStore {
    pub fn new(config_path: &AbsPath) -> Result<PersistentDataStore> {
        // Retrieve the lintrunner-wide data directory.
        let project_dirs = ProjectDirs::from("", "", "lintrunner");
        let project_dirs =
            project_dirs.ok_or_else(|| anyhow!("Could not find project directories"))?;
        let project_data_dir = project_dirs.data_dir();

        // Now compute one specific to this lintrunner config.
        let config_path_hash = blake3::hash(config_path.to_string_lossy().as_bytes()).to_string();
        let config_data_dir = project_data_dir.join(config_path_hash);

        std::fs::create_dir_all(&config_data_dir)?;

        Ok(PersistentDataStore {
            data_dir: config_data_dir,
        })
    }

    pub fn last_init(&self) -> Result<Option<String>> {
        debug!(
            "Checking data file '{}/{}' to see if config has changed",
            self.data_dir.display(),
            CONFIG_DATA_NAME
        );
        let init_path = self.relative_path(CONFIG_DATA_NAME);
        if !init_path.exists() {
            return Ok(None);
        }

        Ok(Some(std::fs::read_to_string(init_path)?))
    }

    pub fn update_last_init(&self, config_path: &AbsPath) -> Result<()> {
        debug!(
            "Writing used config to {}/{}",
            self.data_dir.display(),
            CONFIG_DATA_NAME
        );

        let config_contents = std::fs::read_to_string(config_path)?;
        let path = self.relative_path(CONFIG_DATA_NAME);

        std::fs::write(path, &config_contents)?;
        Ok(())
    }

    fn relative_path(&self, path: impl AsRef<Path>) -> PathBuf {
        self.data_dir.join(path)
    }
}
