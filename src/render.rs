use std::fmt;
use std::io::Write;
use std::path::PathBuf;
use std::{cmp, collections::HashMap, fs};

use anyhow::{anyhow, Result};
use console::{style, Style, Term};
use similar::{ChangeTag, DiffableStr, TextDiff};
use textwrap::indent;

use crate::lint_message::{LintMessage, LintSeverity};
use crate::path::{path_relative_from, AbsPath};

static CONTEXT_LINES: usize = 3;

pub enum PrintedLintErrors {
    Yes,
    No,
}

pub fn render_lint_messages_json(
    stdout: &mut impl Write,
    lint_messages: &HashMap<Option<String>, Vec<LintMessage>>,
) -> Result<PrintedLintErrors> {
    let mut printed = false;
    for lint_message in lint_messages.values().flatten() {
        printed = true;
        writeln!(stdout, "{}", serde_json::to_string(lint_message)?)?;
    }

    if printed {
        Ok(PrintedLintErrors::Yes)
    } else {
        Ok(PrintedLintErrors::No)
    }
}

pub fn render_lint_messages(
    stdout: &mut impl Write,
    lint_messages: &HashMap<Option<String>, Vec<LintMessage>>,
) -> Result<PrintedLintErrors> {
    if lint_messages.is_empty() {
        writeln!(stdout, "{} No lint issues.", style("ok").green())?;

        return Ok(PrintedLintErrors::No);
    }

    let wrap_78_indent_4 = textwrap::Options::new(78)
        .initial_indent(spaces(4))
        .subsequent_indent(spaces(4));

    // Always render messages in sorted order.
    let mut paths: Vec<&Option<String>> = lint_messages.keys().collect();
    paths.sort();

    for path in paths {
        let lint_messages = lint_messages.get(path).unwrap();

        stdout.write_all(b"\n\n")?;

        let current_dir = std::env::current_dir()?;
        match path {
            None => write!(stdout, ">>> General linter failure:\n\n")?,
            Some(path) => {
                // Try to render the path relative to user's current working directory.
                // But if we fail to relativize the path, just print what the linter
                // gave us directly.
                let abs_path = AbsPath::new(PathBuf::from(path));
                let path_to_print = match abs_path {
                    Ok(abs_path) => {
                        // unwrap will never panic because we know `path` is absolute.
                        let relative_path = path_relative_from(
                            abs_path.as_pathbuf().as_path(),
                            current_dir.as_path(),
                        )
                        .unwrap();

                        relative_path.display().to_string()
                    }
                    Err(_) => path.clone(),
                };

                write!(
                    stdout,
                    "{} Lint for {}:\n\n",
                    style(">>>").bold(),
                    style(path_to_print).underlined()
                )?;
            }
        }

        for lint_message in lint_messages {
            write_summary_line(stdout, lint_message)?;

            // Write the description.
            if let Some(description) = &lint_message.description {
                for line in textwrap::wrap(description, &wrap_78_indent_4) {
                    writeln!(stdout, "{}", line)?;
                }
            }

            // If we have original and replacement, show the diff.
            if let (Some(original), Some(replacement)) =
                (&lint_message.original, &lint_message.replacement)
            {
                write_context_diff(stdout, original, replacement)?;
            } else if let (Some(highlight_line), Some(path)) = (&lint_message.line, path) {
                // Otherwise, write the context code snippet.
                write_context(stdout, path, highlight_line)?;
            }
        }
    }

    Ok(PrintedLintErrors::Yes)
}

// Write formatted context lines, with an styled indicator for which line the lint is about
fn write_context(stdout: &mut impl Write, path: &str, highlight_line: &usize) -> Result<()> {
    stdout.write_all(b"\n")?;
    let file = fs::read_to_string(path);
    match file {
        Ok(file) => {
            let lines = file.tokenize_lines();

            let highlight_idx = highlight_line.saturating_sub(1);

            let max_idx = lines.len().saturating_sub(1);
            let start_idx = highlight_idx.saturating_sub(CONTEXT_LINES);
            let end_idx = cmp::min(max_idx, highlight_idx + CONTEXT_LINES);

            for cur_idx in start_idx..=end_idx {
                let line = lines
                    .get(cur_idx)
                    .ok_or_else(|| anyhow!("TODO line mismatch"))?;
                let line_number = cur_idx + 1;

                let max_line_number = max_idx + 1;
                let max_pad = max_line_number.to_string().len();

                // Write `123 |  my failing line content
                if cur_idx == highlight_idx {
                    // Highlight the actually failing line with a chevron + different color
                    write!(
                        stdout,
                        "    >>> {:>width$}  |{}",
                        style(line_number).dim(),
                        style(line).yellow(),
                        width = max_pad
                    )?;
                } else {
                    write!(
                        stdout,
                        "        {:>width$}  |{}",
                        style(line_number).dim(),
                        line,
                        width = max_pad
                    )?;
                }
            }
        }
        Err(e) => {
            let msg = textwrap::indent(
                &format!(
                    "Could not retrieve source context: {}\n\
                    This is typically a linter bug.",
                    e
                ),
                spaces(8),
            );
            write!(stdout, "{}", style(msg).red())?;
        }
    }
    stdout.write_all(b"\n")?;
    Ok(())
}

// Write the context, computing and styling a diff from the original to the suggested replacement.
fn write_context_diff(stdout: &mut impl Write, original: &str, replacement: &str) -> Result<()> {
    writeln!(
        stdout,
        "\n    {}",
        style("You can run `lintrunner -a` to apply this patch.").cyan()
    )?;
    stdout.write_all(b"\n")?;
    let diff = TextDiff::from_lines(original, replacement);

    let mut max_line_number = 1;
    for (_, group) in diff.grouped_ops(3).iter().enumerate() {
        for op in group {
            for change in diff.iter_inline_changes(op) {
                let old_line = change.old_index().unwrap_or(0) + 1;
                let new_line = change.new_index().unwrap_or(0) + 1;
                max_line_number = cmp::max(max_line_number, old_line);
                max_line_number = cmp::max(max_line_number, new_line);
            }
        }
    }
    let max_pad = max_line_number.to_string().len();

    for (idx, group) in diff.grouped_ops(3).iter().enumerate() {
        if idx > 0 {
            writeln!(stdout, "{:-^1$}", "-", 80)?;
        }
        for op in group {
            for change in diff.iter_inline_changes(op) {
                let (sign, s) = match change.tag() {
                    ChangeTag::Delete => ("-", Style::new().red()),
                    ChangeTag::Insert => ("+", Style::new().green()),
                    ChangeTag::Equal => (" ", Style::new().dim()),
                };
                let changeset = Changeset {
                    max_pad,
                    old: change.old_index(),
                    new: change.new_index(),
                };
                write!(
                    stdout,
                    "    {} |{}",
                    style(changeset).dim(),
                    s.apply_to(sign).bold()
                )?;
                for (emphasized, value) in change.iter_strings_lossy() {
                    if emphasized {
                        write!(stdout, "{}", s.apply_to(value).underlined().on_black())?;
                    } else {
                        write!(stdout, "{}", s.apply_to(value))?;
                    }
                }
                if change.missing_newline() {
                    stdout.write_all(b"\n")?;
                }
            }
        }
    }
    stdout.write_all(b"\n")?;
    Ok(())
}

// Write: `   Error  (LINTER) prefer-using-this-over-that\n`
fn write_summary_line(stdout: &mut impl Write, lint_message: &LintMessage) -> Result<()> {
    let error_style = match lint_message.severity {
        LintSeverity::Error => Style::new().on_red().bold(),
        LintSeverity::Warning | LintSeverity::Advice | LintSeverity::Disabled => {
            Style::new().on_yellow().bold()
        }
    };
    writeln!(
        stdout,
        "  {} ({}) {}",
        error_style.apply_to(lint_message.severity.label()),
        lint_message.code,
        style(&lint_message.name).underlined(),
    )?;
    Ok(())
}

fn bspaces(len: u8) -> &'static [u8] {
    const SPACES: [u8; 255] = [b' '; 255];
    &SPACES[0..len as usize]
}

/// Short 'static strs of spaces.
fn spaces(len: u8) -> &'static str {
    // SAFETY: `SPACES` is valid UTF-8 since it is all spaces.
    unsafe { std::str::from_utf8_unchecked(bspaces(len)) }
}

struct Changeset {
    // The length of the largest line number we'll be printing.
    max_pad: usize,
    old: Option<usize>,
    new: Option<usize>,
}
impl fmt::Display for Changeset {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        // We want things to get formatted like:
        // 1234  1235
        //     ^^ two spaces
        match (self.old, self.new) {
            (Some(old), Some(new)) => {
                // +1 because we want to print the line number, not the vector index.
                let old = old + 1;
                let new = new + 1;
                write!(
                    f,
                    "{:>left_pad$}  {:>right_pad$}",
                    old,
                    new,
                    left_pad = self.max_pad,
                    right_pad = self.max_pad,
                )
            }
            // In cases where old/new are missing, do an approximation:
            // '1234      '
            //        ^^^^ length of '1234' mirrored to the other side
            //      ^^ two spaces still
            (Some(old), None) => {
                write!(f, "{:>width$}  {:width$}", old, " ", width = self.max_pad)
            }
            (None, Some(new)) => {
                let new = new + 1;
                write!(f, "{:width$}  {:>width$}", " ", new, width = self.max_pad)
            }
            (None, None) => unreachable!(),
        }
    }
}

struct Line(Option<usize>);

impl fmt::Display for Line {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self.0 {
            None => write!(f, "    "),
            Some(idx) => write!(f, "{:<4}", idx + 1),
        }
    }
}

pub fn print_error(err: &anyhow::Error) -> std::io::Result<()> {
    let mut stderr = Term::stderr();
    let mut chain = err.chain();

    if let Some(error) = chain.next() {
        write!(stderr, "{} ", style("error:").red().bold())?;
        let indented = indent(&format!("{}", error), spaces(7));
        writeln!(stderr, "{}", indented)?;

        for cause in chain {
            write!(stderr, "{} ", style("caused_by:").red().bold())?;
            write!(stderr, " ")?;
            let indented = indent(&format!("{}", cause), spaces(11));
            writeln!(stderr, "{}", indented)?;
        }
    }

    Ok(())
}
