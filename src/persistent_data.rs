//! Utilities to handle data that we want to persist across invocations of
//! lintrunner.
//!
//! This data will be placed in a platform specific location (unless overridden
//! by the user). To distinguish between different `.lintrunner.toml` configs,
//! we hash the absolute path to the config and include that as part of the
//! directory structure for persistent data.

use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use serde::{de::DeserializeOwned, Serialize};
use std::{fs::File, path::PathBuf};

use crate::path::AbsPath;

/// Single way to interact with persistent data for a given run of lintrunner.
/// This is scoped to a single .lintrunner.toml config.
pub struct PersistentDataStore {
    pub data_dir: PathBuf,
}

impl PersistentDataStore {
    pub fn new(config_path: &AbsPath) -> Result<PersistentDataStore> {
        // Retrieve the lintrunner-wide data directory.
        let project_dirs = ProjectDirs::from("", "", "lintrunner");
        let project_dirs =
            project_dirs.ok_or_else(|| anyhow!("Could not find project directories"))?;
        let project_data_dir = project_dirs.data_dir();
        if !project_data_dir.exists() {
            std::fs::create_dir_all(project_data_dir)?;
        }

        // Now compute one specific to lthis lintrunner config.
        let config_path_hash = blake3::hash(config_path.to_string_lossy().as_bytes()).to_string();
        let config_data_dir = project_data_dir.join(config_path_hash);

        if !config_data_dir.exists() {
            std::fs::create_dir(&config_data_dir)?;
        }

        Ok(PersistentDataStore {
            data_dir: config_data_dir,
        })
    }

    pub fn exists(&self, key: &str) -> bool {
        self.data_dir.join(key).exists()
    }

    pub fn load_json<T: Serialize + DeserializeOwned>(&self, key: &str) -> Result<T> {
        let path = self.data_dir.join(key);
        let file = File::open(path)?;

        Ok(serde_json::from_reader(file)?)
    }

    pub fn store_json(&self, key: &str, value: &impl Serialize) -> Result<()> {
        let path = self.data_dir.join(key);
        let file = File::create(path)?;

        serde_json::to_writer(file, value)?;

        Ok(())
    }

    pub fn load_string(&self, key: &str) -> Result<String> {
        let path = self.data_dir.join(key);

        Ok(std::fs::read_to_string(path)?)
    }

    pub fn store_string(&self, key: &str, value: &str) -> Result<()> {
        let path = self.data_dir.join(key);

        std::fs::write(path, value)?;

        Ok(())
    }
}
