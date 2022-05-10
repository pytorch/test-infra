//! Utilities to handle data that we want to persist across invocations of
//! lintrunner.
//!
//! This data will be placed in a platform specific location (unless overridden
//! by the user). To distinguish between different `.lintrunner.toml` configs,
//! we hash the absolute path to the config and include that as part of the
//! directory structure for persistent data.

use anyhow::{anyhow, bail, Context, Result};
use directories::ProjectDirs;
use log::debug;
use serde::{Deserialize, Serialize};
use std::{
    fmt::Write,
    path::{Path, PathBuf},
};

use crate::path::AbsPath;

const CONFIG_DATA_NAME: &str = ".lintrunner.toml";
const RUNS_DIR_NAME: &str = "runs";
const MAX_RUNS_TO_STORE: usize = 10;

/// Single way to interact with persistent data for a given run of lintrunner.
/// This is scoped to a single .lintrunner.toml config.
pub struct PersistentDataStore {
    data_dir: PathBuf,
    runs_dir: PathBuf,
    cur_run_info: RunInfo,
}

/// Encapsulates information about a specific run of `lintrunner`
#[derive(Serialize, Deserialize)]
pub struct RunInfo {
    pub args: Vec<String>,
    pub timestamp: String,
}

#[derive(Serialize, Deserialize)]
pub struct ExitInfo {
    pub code: i32,
    pub err: Option<String>,
}

impl RunInfo {
    // Get the directory (relative to the runs dir) that stores data specific to
    // this run.
    fn dir_name(&self) -> String {
        let args = blake3::hash(self.args.join("_").as_bytes()).to_string();
        self.timestamp.clone() + "_" + &args
    }
}

impl PersistentDataStore {
    pub fn new(config_path: &AbsPath, cur_run_info: RunInfo) -> Result<PersistentDataStore> {
        // Retrieve the lintrunner-wide data directory.
        let project_dirs = ProjectDirs::from("", "", "lintrunner");
        let project_dirs =
            project_dirs.ok_or_else(|| anyhow!("Could not find project directories"))?;
        let project_data_dir = project_dirs.data_dir();

        // Now compute one specific to this lintrunner config.
        let config_path_hash = blake3::hash(config_path.to_string_lossy().as_bytes()).to_string();
        let config_data_dir = project_data_dir.join(config_path_hash);

        // Create the runs dir as well.
        let runs_dir = config_data_dir.join(RUNS_DIR_NAME);
        let cur_run_dir = runs_dir.join(cur_run_info.dir_name());

        std::fs::create_dir_all(&cur_run_dir)?;

        PersistentDataStore::clean_old_runs(&runs_dir)?;

        Ok(PersistentDataStore {
            data_dir: config_data_dir,
            runs_dir,
            cur_run_info,
        })
    }

    fn clean_old_runs(runs_dir: &Path) -> Result<()> {
        let mut entries = std::fs::read_dir(runs_dir)?
            .map(|res| res.map(|e| e.path()))
            .collect::<Result<Vec<_>, std::io::Error>>()?;

        if entries.len() >= MAX_RUNS_TO_STORE {
            debug!("Found more than {MAX_RUNS_TO_STORE} runs, cleaning some up");

            entries.sort_unstable();

            let num_to_delete = entries.len() - MAX_RUNS_TO_STORE;
            for dir in entries.iter().take(num_to_delete) {
                debug!("Deleting old run: {}", dir.display());
                std::fs::remove_dir_all(dir)?;
            }
        }
        Ok(())
    }

    pub fn log_file(&self) -> PathBuf {
        self.runs_dir
            .join(self.cur_run_info.dir_name())
            .join("log.txt")
    }

    pub fn write_run_info(&self, exit_info: ExitInfo) -> Result<()> {
        let run_path = self.runs_dir.join(self.cur_run_info.dir_name());
        debug!("Writing run info to {}", run_path.display());

        if !run_path.exists() {
            std::fs::create_dir(&run_path)?;
        }
        let run_info = serde_json::to_string_pretty(&self.cur_run_info)?;
        std::fs::write(&run_path.join("run_info.json"), &run_info)?;

        let exit_info = serde_json::to_string_pretty(&exit_info)?;
        std::fs::write(&run_path.join("exit_info.json"), exit_info)?;
        Ok(())
    }

    pub fn get_run_report(&self, run_info: &RunInfo) -> Result<String> {
        let run_path = self.runs_dir.join(run_info.dir_name());
        debug!("Generating run report from {}", run_path.display());

        let log =
            std::fs::read_to_string(run_path.join("log.txt")).context("retrieving log file")?;

        let mut ret = String::new();

        write!(
            ret,
            "lintrunner rage report:\n\
            timestamp: {}\n\
            args: {}\n",
            run_info.timestamp,
            run_info
                .args
                .iter()
                .map(|x| format!("'{x}'"))
                .collect::<Vec<_>>()
                .join(" "),
        )?;

        let exit_info_path = run_path.join("exit_info.json");
        if exit_info_path.exists() {
            let exit_info =
                std::fs::read_to_string(exit_info_path).context("retrieving exit info json")?;
            let exit_info: ExitInfo =
                serde_json::from_str(&exit_info).context("deserializing exit info")?;
            write!(
                ret,
                "exit code: {}\n\
                 err msg: {:?}\n\n",
                exit_info.code, exit_info.err,
            )?;
        } else {
            writeln!(ret, "EXIT INFO MISSING")?;
        }
        writeln!(ret, "========= BEGIN LOGS =========")?;
        ret.write_str(&log)?;

        Ok(ret)
    }

    fn past_run_dirs(&self) -> Result<Vec<PathBuf>> {
        debug!("Reading past runs from {}", self.runs_dir.display());

        let mut run_dirs = std::fs::read_dir(&self.runs_dir)?
            .map(|res| res.map(|e| e.path()))
            .collect::<Result<Vec<_>, std::io::Error>>()?;

        run_dirs.sort_unstable();
        run_dirs.reverse();
        Ok(run_dirs)
    }

    pub fn past_run(&self, invocation: usize) -> Result<RunInfo> {
        let run_dirs = self.past_run_dirs()?;

        let dir = run_dirs.get(invocation);
        match dir {
            Some(dir) => {
                let run_info: RunInfo =
                    serde_json::from_str(&std::fs::read_to_string(dir.join("run_info.json"))?)?;
                Ok(run_info)
            }
            None => {
                bail!(
                    "Tried to request run #{invocation}, but didn't find it. \
                     (lintrunner only stores the last {MAX_RUNS_TO_STORE} runs)"
                );
            }
        }
    }

    pub fn past_runs(&self) -> Result<Vec<(RunInfo, ExitInfo)>> {
        let run_dirs = self.past_run_dirs()?;

        let mut ret = Vec::new();

        // Skip the first one as it is the current run.
        for dir in run_dirs.into_iter().skip(1) {
            debug!("Reading run info from {}", dir.display());

            let run_info: RunInfo =
                serde_json::from_str(&std::fs::read_to_string(dir.join("run_info.json"))?)?;
            let exit_info: ExitInfo =
                serde_json::from_str(&std::fs::read_to_string(dir.join("exit_info.json"))?)?;
            ret.push((run_info, exit_info));
        }
        Ok(ret)
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn basic_data_doesnt_fail() {
        let f = NamedTempFile::new().unwrap();
        let config = AbsPath::try_from(f.path()).unwrap();

        let run_info = RunInfo {
            timestamp: "0".to_string(),
            args: vec!["foo".to_string(), "bar".to_string()],
        };
        let store = PersistentDataStore::new(&config, run_info).unwrap();
        // Try to cleanup
        std::fs::remove_dir_all(store.data_dir).unwrap();
    }

    #[test]
    fn old_run_cleanup() {
        let f = NamedTempFile::new().unwrap();
        let config = AbsPath::try_from(f.path()).unwrap();

        let run_info = RunInfo {
            timestamp: "0".to_string(),
            args: vec!["foo".to_string(), "bar".to_string()],
        };
        let store = PersistentDataStore::new(&config, run_info).unwrap();

        // Simulate some more runs.
        for i in 1..20 {
            let run_info = RunInfo {
                timestamp: i.to_string(),
                args: vec!["foo".to_string(), "bar".to_string()],
            };
            let store = PersistentDataStore::new(&config, run_info).unwrap();
            store
                .write_run_info(ExitInfo { code: 0, err: None })
                .unwrap()
        }

        // We should have 10 runs, since old ones should have been collected.
        let num_entries = std::fs::read_dir(store.runs_dir).unwrap().count();
        assert_eq!(num_entries, MAX_RUNS_TO_STORE);

        // Try to clean up
        std::fs::remove_dir_all(store.data_dir).unwrap();
    }
}
