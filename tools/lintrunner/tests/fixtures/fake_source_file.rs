use anyhow::Result;
use assert_cmd::Command;
use insta::assert_yaml_snapshot;
use lintrunner::lint_message::{LintMessage, LintSeverity};
use regex::Regex;
use std::io::Write;

fn assert_output_snapshot(cmd: &mut Command) -> Result<()> {
    let re = Regex::new("'.*test-lintrunner-config.*toml'").unwrap();
    let output = cmd.output()?;

    let output_string = format!(
        "STDOUT:\n{}\n\nSTDERR:\n{}",
        std::str::from_utf8(&output.stdout)?,
        std::str::from_utf8(&output.stderr)?,
    );
    let output_lines = output_string.lines().collect::<Vec<_>>();

    assert_yaml_snapshot!(
        output_lines,
        // Define a dynamic redaction on all lines. This will replace the config
        // name (which is a tempfile that changes from run to run) with a fixed value.
        // Everything else is passed through normally.
        {
            "[]" => insta::dynamic_redaction(move |value, _path|
                {
                    re.replace(value.as_str().unwrap(), "<temp-config>").to_string()
                }
            ),
        }
    );
    Ok(())
}
