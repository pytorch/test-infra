use anyhow::Result;
use assert_cmd::Command;
use insta::assert_yaml_snapshot;
use regex::Regex;
use std::io::Write;

fn assert_output_snapshot(cmd: &mut Command) -> Result<()> {
    let re = Regex::new("test-lintrunner-config(.*)toml").unwrap();
    let output = cmd.output()?;
    assert_yaml_snapshot!(std::str::from_utf8(&output.stderr)?
        .lines()
        .collect::<Vec<_>>(),
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
    assert_yaml_snapshot!(std::str::from_utf8(&output.stdout)?
        .lines()
        .collect::<Vec<_>>());
    Ok(())
}

fn temp_config(contents: &str) -> Result<tempfile::NamedTempFile> {
    let mut config = tempfile::Builder::new()
        .prefix("test-lintrunner-config")
        .suffix(".toml")
        .tempfile()?;
    config.write_all(contents.as_bytes())?;
    Ok(config)
}

#[test]
fn unknown_config_fails() -> Result<()> {
    let mut cmd = Command::cargo_bin("lintrunner")?;
    cmd.arg("--config=asdfasdfasdf");
    cmd.assert().failure();
    assert_output_snapshot(&mut cmd)?;

    Ok(())
}

#[test]
fn invalid_config_fails() -> Result<()> {
    let config = temp_config("asdf = 'lol'\n")?;

    let mut cmd = Command::cargo_bin("lintrunner")?;
    cmd.arg(format!("--config={}", config.path().to_str().unwrap()));
    cmd.assert().failure();
    assert_output_snapshot(&mut cmd)?;

    Ok(())
}

#[test]
fn no_op_config_succeeds() -> Result<()> {
    let config = temp_config(
        "\
            [[linter]]
            code = 'TESTLINTER'
            include_patterns = []
            command = ['echo', 'foo']
        ",
    )?;

    let mut cmd = Command::cargo_bin("lintrunner")?;
    cmd.arg(format!("--config={}", config.path().to_str().unwrap()));
    cmd.assert().success();
    assert_output_snapshot(&mut cmd)?;

    Ok(())
}

#[test]
fn empty_command_fails() -> Result<()> {
    let config = temp_config(
        "\
            [[linter]]
            code = 'TESTLINTER'
            include_patterns = ['**']
            command = []
        ",
    )?;

    let mut cmd = Command::cargo_bin("lintrunner")?;
    cmd.arg(format!("--config={}", config.path().to_str().unwrap()));
    cmd.assert().failure();
    assert_output_snapshot(&mut cmd)?;

    Ok(())
}
