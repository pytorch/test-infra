use std::fmt;
use std::io::Write;
use std::path::Path;
use std::{cmp, collections::HashMap, fs, path::PathBuf};

use anyhow::{Context, Result};
use console::{style, Color, Style, Term};
use indent_write::io::IndentWriter;
use similar::{ChangeTag, DiffableStr, TextDiff};

use crate::lint_message::{LintMessage, LintSeverity};

static CONTEXT_LINES: usize = 3;

pub enum PrintedLintErrors {
    Yes,
    No,
}

pub fn render_lint_messages(
    lint_messages: &HashMap<PathBuf, Vec<LintMessage>>,
) -> Result<PrintedLintErrors> {
    let mut stdout = Term::stdout();
    if lint_messages.is_empty() {
        stdout.write_line(format!("{} {}", style("ok").green(), "No lint issues.").as_str())?;

        return Ok(PrintedLintErrors::No);
    }

    let wrap_78_indent_4 = textwrap::Options::new(78)
        .initial_indent(spaces(4))
        .subsequent_indent(spaces(4));

    // Always render messages in sorted order.
    let mut paths: Vec<&Path> = lint_messages.keys().map(|p| p.as_path()).collect();
    paths.sort();

    for path in paths {
        let lint_messages = lint_messages.get(path).unwrap();

        stdout.write_all(b"\n\n")?;
        stdout.write_line(&format!(
            "{} Lint for {}:\n",
            style(">>>").bold(),
            style(path.to_string_lossy()).underlined()
        ))?;

        for lint_message in lint_messages {
            // Write: `   Error  (LINTER) prefer-using-this-over-that\n`
            let error_style = match lint_message.severity {
                LintSeverity::Error => Style::new().bg(Color::Red).bold(),
                LintSeverity::Warning | LintSeverity::Advice | LintSeverity::Disabled => {
                    Style::new().bg(Color::Yellow).bold()
                }
            };
            stdout.write_line(&format!(
                "  {} ({}) {}",
                error_style.apply_to(lint_message.severity.label()),
                lint_message.code,
                style(&lint_message.name).underlined(),
            ))?;

            // Write the description.

            if let Some(description) = &lint_message.description {
                for line in textwrap::wrap(description, &wrap_78_indent_4) {
                    stdout.write_line(&line)?;
                }
            }

            // If we have original and replacement, show the diff.
            // Write the context code snippet.
            if let (Some(original), Some(replacement)) =
                (&lint_message.original, &lint_message.replacement)
            {
                stdout.write_all(b"\n")?;
                let diff = TextDiff::from_lines(original, replacement);

                for (idx, group) in diff.grouped_ops(3).iter().enumerate() {
                    if idx > 0 {
                        write!(stdout, "{:-^1$}\n", "-", 80)?;
                    }
                    for op in group {
                        for change in diff.iter_inline_changes(op) {
                            let (sign, s) = match change.tag() {
                                ChangeTag::Delete => ("-", Style::new().red()),
                                ChangeTag::Insert => ("+", Style::new().green()),
                                ChangeTag::Equal => (" ", Style::new().dim()),
                            };
                            write!(
                                stdout,
                                "    {}{} |{}",
                                style(Line(change.old_index())).dim(),
                                style(Line(change.new_index())).dim(),
                                s.apply_to(sign).bold(),
                            )?;
                            for (emphasized, value) in change.iter_strings_lossy() {
                                if emphasized {
                                    write!(
                                        stdout,
                                        "{}",
                                        s.apply_to(value).underlined().on_black()
                                    )?;
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
            } else if let Some(line_number) = &lint_message.line {
                stdout.write_all(b"\n")?;

                let file = fs::read_to_string(path).context(format!(
                    "Error reading file: '{}' when rendering lints",
                    path.display()
                ))?;
                let lines = file.tokenize_lines();

                // subtract 1 because lines are reported as 1-indexed, but the
                // lines vector is 0-indexed.
                // Use saturating arithmetic to avoid underflow.
                let line_idx = line_number.saturating_sub(1);
                let max_idx = lines.len().saturating_sub(1);

                // Print surrounding context
                let start_idx = line_idx.saturating_sub(CONTEXT_LINES);
                let end_idx = cmp::min(max_idx, line_idx + CONTEXT_LINES);

                for cur_idx in start_idx..=end_idx {
                    let line = lines
                        .get(cur_idx)
                        .ok_or(anyhow::Error::msg("TODO line mismatch"))?;
                    let line_number = cur_idx + 1;

                    // Wrlte `123 |  my failing line content

                    if cur_idx == line_idx {
                        // Highlight the actually failing line with a chevron + different color
                        write!(stdout, "    >>> {}  |", style(line_number).dim())?;
                        write!(stdout, "{}", style(line).yellow())?;
                    } else {
                        write!(stdout, "        {}  |", style(line_number).dim())?;
                        stdout.write_all(line.as_bytes())?;
                    }
                }

                stdout.write_all(b"\n")?;
            }
        }
    }

    Ok(PrintedLintErrors::Yes)
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
        let mut indenter = IndentWriter::new_skip_initial(spaces(7), &mut stderr);
        writeln!(indenter, "{}", error)?;

        for cause in chain {
            write!(stderr, "{} ", style("caused_by:").red().bold())?;
            write!(stderr, " ")?;
            let mut indenter = IndentWriter::new_skip_initial(spaces(11), &mut stderr);
            writeln!(indenter, "{}", cause)?;
        }
    }

    Ok(())
}
