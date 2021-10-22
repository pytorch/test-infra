use std::fmt;
use std::io::Write;
use std::path::Path;
use std::{cmp, collections::HashMap, fs, path::PathBuf};

use anyhow::{Context, Result};
use console::{style, Style};
use similar::{ChangeTag, DiffableStr, TextDiff};
use termcolor::{BufferWriter, Color, ColorChoice, ColorSpec, WriteColor};

use crate::lint_message::{LintMessage, LintSeverity};

static CONTEXT_LINES: usize = 3;

pub enum PrintedLintErrors {
    Yes,
    No,
}

pub fn render_lint_messages(lint_messages: &HashMap<PathBuf, Vec<LintMessage>>) -> Result<PrintedLintErrors> {
    let palette = Palette::new();
    let stdout = BufferWriter::stdout(if atty::is(atty::Stream::Stdout) {
        ColorChoice::Auto
    } else {
        ColorChoice::Never
    });
    let mut buf = stdout.buffer();
    if lint_messages.is_empty() {
        buf.write_all(format!("{} {}\n", style("ok").green(), "No lint issues.").as_bytes())?;
        stdout.print(&buf)?;

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

        buf.write_all(b"\n\n")?;

        buf.set_color(&palette.attention)?;
        buf.write_all(b">>>")?;
        buf.reset()?;

        buf.write_all(b" Lint for ")?;

        buf.set_color(&palette.subject)?;
        buf.write_all(path.to_string_lossy().as_bytes())?;
        buf.reset()?;

        buf.write_all(b":\n")?;

        for lint_message in lint_messages {
            buf.write_all(b"\n")?;
            // Write: `   Error  (LINTER) prefer-using-this-over-that\n`

            buf.write_all(bspaces(2))?;
            buf.set_color(match lint_message.severity {
                LintSeverity::Error => &palette.error,
                LintSeverity::Warning | LintSeverity::Advice | LintSeverity::Disabled => {
                    &palette.warning
                }
            })?;
            write!(buf, " {} ", lint_message.severity.label())?;
            buf.reset()?;

            write!(buf, " ({}) ", lint_message.code)?;

            buf.set_color(&palette.subject)?;
            write!(buf, "{}", lint_message.name)?;
            buf.reset()?;
            buf.write_all(b"\n")?;

            // Write the description.

            if let Some(description) = &lint_message.description {
                for line in textwrap::wrap(description, &wrap_78_indent_4) {
                    buf.write_all(line.as_bytes())?;
                    buf.write_all(b"\n")?;
                }
            }

            // If we have original and replacement, show the diff.
            // Write the context code snippet.
            if let (Some(original), Some(replacement)) =
                (&lint_message.original, &lint_message.replacement)
            {
                buf.write_all(b"\n")?;
                let diff = TextDiff::from_lines(original, replacement);

                for (idx, group) in diff.grouped_ops(3).iter().enumerate() {
                    if idx > 0 {
                        buf.write_all(format!("{:-^1$}\n", "-", 80).as_bytes())?;
                    }
                    for op in group {
                        for change in diff.iter_inline_changes(op) {
                            let (sign, s) = match change.tag() {
                                ChangeTag::Delete => ("-", Style::new().red()),
                                ChangeTag::Insert => ("+", Style::new().green()),
                                ChangeTag::Equal => (" ", Style::new().dim()),
                            };
                            buf.write_all(
                                format!(
                                    "    {}{} |{}",
                                    style(Line(change.old_index())).dim(),
                                    style(Line(change.new_index())).dim(),
                                    s.apply_to(sign).bold(),
                                )
                                .as_bytes(),
                            )?;
                            for (emphasized, value) in change.iter_strings_lossy() {
                                if emphasized {
                                    buf.write_all(
                                        format!("{}", s.apply_to(value).underlined().on_black())
                                            .as_bytes(),
                                    )?;
                                } else {
                                    buf.write_all(format!("{}", s.apply_to(value)).as_bytes())?;
                                }
                            }
                            if change.missing_newline() {
                                buf.write_all(b"\n")?;
                            }
                        }
                    }
                }

                buf.write_all(b"\n")?;
            } else if let Some(line_number) = &lint_message.line {
                let file = fs::read_to_string(path).context(format!(
                    "Error reading file: '{}' when rendering lints",
                    path.display()
                ))?;
                let lines = file.tokenize_lines();

                buf.write_all(b"\n")?;

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
                        buf.write_all(
                            format!("    >>> {}  |", style(line_number).dim()).as_bytes(),
                        )?;
                        buf.write_all(format!("{}", style(line).yellow()).as_bytes())?;
                    } else {
                        buf.write_all(
                            format!("        {}  |", style(line_number).dim()).as_bytes(),
                        )?;
                        buf.write_all(line.as_bytes())?;
                    }
                }
            }
        }
    }

    stdout.print(&buf)?;

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

struct Palette {
    error: ColorSpec,
    warning: ColorSpec,

    attention: ColorSpec,
    subject: ColorSpec,
}

impl Palette {
    fn new() -> Palette {
        let mut bold = ColorSpec::new();
        bold.set_bold(true).set_reset(false);

        let mut underline = ColorSpec::new();
        underline.set_underline(true).set_reset(false);

        let mut bold_red_bg = ColorSpec::new();
        bold_red_bg
            .set_bg(Some(Color::Red))
            .set_bold(true)
            .set_reset(false);

        let mut bold_yellow_bg = ColorSpec::new();
        bold_yellow_bg
            .set_bg(Some(Color::Yellow))
            .set_bold(true)
            .set_reset(false);

        let mut inverse = ColorSpec::new();
        inverse
            .set_fg(Some(Color::Black))
            .set_bg(Some(Color::White))
            .set_reset(false);

        Palette {
            error: bold_red_bg,
            warning: bold_yellow_bg,
            attention: bold,
            subject: underline,
            // highlight: inverse,
        }
    }
}
