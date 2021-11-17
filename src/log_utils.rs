use log::{debug, trace};

pub fn log_files<T>(message: &str, files: &T)
where
    T: std::fmt::Debug,
{
    debug!("{} <use -vv to see this list>", message);
    trace!("{}{:?}", message, files);
}
