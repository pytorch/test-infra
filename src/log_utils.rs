use anyhow::{bail, Result};
use std::process::Output;

use log::{debug, trace};

pub fn log_files<T>(message: &str, files: &T)
where
    T: std::fmt::Debug,
{
    debug!("{} <use -vv to see this list>", message);
    trace!("{}{:?}", message, files);
}

pub fn ensure_output(program_name: &str, output: &Output) -> Result<()> {
    if !output.status.success() {
        let stderr = std::str::from_utf8(&output.stderr)?;
        let stdout = std::str::from_utf8(&output.stdout)?;
        bail!(
            "{} failed with non-zero exit code.\n\
                 STDERR:\n{}\n\nSTDOUT:{}\n",
            program_name,
            stderr,
            stdout,
        );
    }
    Ok(())
}
