use anyhow::{bail, Result};
use console::{style, Term};
use fern::colors::{Color, ColoredLevelConfig};
use std::path::Path;
use std::process::Output;

use log::Level::Trace;
use log::{debug, log_enabled, trace, LevelFilter};

pub fn log_files<T>(message: &str, files: &T)
where
    T: std::fmt::Debug,
{
    if !log_enabled!(Trace) {
        debug!("{} <use -vv to see this list>", message);
    }

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

pub fn setup_logger(log_level: LevelFilter, log_file: &Path, force_color: bool) -> Result<()> {
    let builder = fern::Dispatch::new();

    let isatty = Term::stderr().features().is_attended();
    if isatty || force_color {
        // Use colors in our terminal output if we're on a tty
        let log_colors = ColoredLevelConfig::new()
            .trace(Color::Cyan)
            .debug(Color::Blue)
            .info(Color::Green)
            .warn(Color::Yellow)
            .error(Color::Red);
        builder
            .chain(
                fern::Dispatch::new()
                    .format(move |out, message, record| {
                        out.finish(format_args!(
                            "{}{} {} {}{} {}",
                            style("[").dim(),
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                            log_colors.color(record.level()),
                            record.target(),
                            style("]").dim(),
                            message
                        ))
                    })
                    .level(log_level)
                    .chain(std::io::stderr()),
            )
            .chain(
                fern::Dispatch::new()
                    .format(move |out, message, record| {
                        out.finish(format_args!(
                            "[{} {} {}] {}",
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                            record.level(),
                            record.target(),
                            message
                        ))
                    })
                    .level(LevelFilter::Trace)
                    .chain(fern::log_file(log_file)?),
            )
            .apply()?;
    } else {
        builder
            .format(move |out, message, record| {
                out.finish(format_args!(
                    "[{} {} {}] {}",
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    record.level(),
                    record.target(),
                    message
                ))
            })
            .chain(
                fern::Dispatch::new()
                    .level(log_level)
                    .chain(std::io::stderr()),
            )
            .chain(
                fern::Dispatch::new()
                    .level(LevelFilter::Trace)
                    .chain(fern::log_file(log_file)?),
            )
            .apply()?;
    }
    Ok(())
}
