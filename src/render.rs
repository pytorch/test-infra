use std::fmt;
use std::io::Write;
use std::{cmp, collections::HashMap, fs};

use anyhow::{Context, Result};
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
    lint_messages: &HashMap<Option<AbsPath>, Vec<LintMessage>>,
) -> Result<PrintedLintErrors> {
    let mut printed = false;
    for (_, lint_message) in lint_messages {
        for lint_message in lint_message {
            printed = true;
            write!(stdout, "{}\n", lint_message.to_json()?)?;
        }
    }

    if printed {
        Ok(PrintedLintErrors::Yes)
    } else {
        Ok(PrintedLintErrors::No)
    }
}

pub fn render_lint_messages(
    stdout: &mut impl Write,
    lint_messages: &HashMap<Option<AbsPath>, Vec<LintMessage>>,
) -> Result<PrintedLintErrors> {
    if lint_messages.is_empty() {
        write!(stdout, "{} {}\n", style("ok").green(), "No lint issues.")?;

        return Ok(PrintedLintErrors::No);
    }

    let wrap_78_indent_4 = textwrap::Options::new(78)
        .initial_indent(spaces(4))
        .subsequent_indent(spaces(4));

    // Always render messages in sorted order.
    let mut paths: Vec<&Option<AbsPath>> = lint_messages.keys().collect();
    paths.sort();

    for path in paths {
        let lint_messages = lint_messages.get(path).unwrap();

        // Write path relative to user's current working directory.
        stdout.write_all(b"\n\n")?;

        let current_dir = std::env::current_dir()?;
        if let Some(abs_path) = path {
            // unwrap will never panic because we know `path` is absolute.
            let relative_path =
                path_relative_from(abs_path.as_pathbuf().as_path(), current_dir.as_path()).unwrap();
            write!(
                stdout,
                "{} Lint for {}:\n\n",
                style(">>>").bold(),
                style(relative_path.display()).underlined()
            )?;
        } else {
            write!(stdout, ">>> General linter failure:\n\n")?;
        }

        for lint_message in lint_messages {
            // Write: `   Error  (LINTER) prefer-using-this-over-that\n`
            let error_style = match lint_message.severity {
                LintSeverity::Error => Style::new().on_red().bold(),
                LintSeverity::Warning | LintSeverity::Advice | LintSeverity::Disabled => {
                    Style::new().on_yellow().bold()
                }
            };
            write!(
                stdout,
                "  {} ({}) {}\n",
                error_style.apply_to(lint_message.severity.label()),
                lint_message.code,
                style(&lint_message.name).underlined(),
            )?;

            // Write the description.

            if let Some(description) = &lint_message.description {
                for line in textwrap::wrap(description, &wrap_78_indent_4) {
                    write!(stdout, "{}\n", line)?;
                }
            }

            // If we have original and replacement, show the diff.
            // Write the context code snippet.
            if let (Some(original), Some(replacement)) =
                (&lint_message.original, &lint_message.replacement)
            {
                write!(
                    stdout,
                    "\n    {}\n",
                    style("You can run `lintrunner -a` to apply this patch.").cyan()
                )?;
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
                            let changeset = Changeset {
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
            } else if let (Some(line_number), Some(path)) = (&lint_message.line, path) {
                stdout.write_all(b"\n")?;

                let file = fs::read_to_string(path.as_pathbuf()).context(format!(
                    "Error reading file: '{}' when rendering lints",
                    path.as_pathbuf().display()
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

struct Changeset {
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
                write!(f, "{}  {}", old, new)
            }
            // In cases where old/new are missing, do an approximation:
            // '1234      '
            //        ^^^^ length of '1234' mirrored to the other side
            //      ^^ two spaces still
            (Some(old), None) => {
                let old = old + 1;
                let total_length = old.to_string().len() * 2 + 2;
                write!(f, "{:<width$}", old, width = total_length)
            }
            (None, Some(new)) => {
                let new = new + 1;
                let total_length = new.to_string().len() * 2 + 2;
                write!(f, "{:>width$}", new, width = total_length)
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
