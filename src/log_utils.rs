use std::collections::HashSet;

use log::{debug, trace};

use crate::path::AbsPath;

pub fn log_files(message: &str, files: &[AbsPath]) {
    debug!("{} <use -vv to see this list>", message);
    trace!("{}{:?}", message, files);
}

pub fn log_files_str(message: &str, files: &HashSet<String>) {
    debug!("{} <use -vv to see this list>", message);
    trace!("{}{:?}", message, files);
}
