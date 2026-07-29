//! Marker-based regression tests for log classification.
//!
//! Each `fixtures/classify/*.txt` is a real CI-log fragment, pasted verbatim
//! from the HUD / GitHub raw log (timestamps and ANSI intact) and trimmed to a
//! window that keeps the *confusers* around the real failure. The engine is a
//! priority-arbitration system, so what we assert is: given this noisy log,
//! which line does the classifier surface, and what does it capture from it?
//!
//! ## Fixture format
//!
//! The expectation lives *in the fixture*, in-band, so the surrounding context
//! is right there to read:
//!
//!   - The line the classifier lands on is prefixed with `#=MATCH=# ` (at
//!     column 0, before the GHA timestamp), and each captured span within it is
//!     wrapped in `‹ ›`. The whole line (prefix + delimiters) shows both *which*
//!     line and *what group key* HUD would produce.
//!   - A fixture the classifier does NOT classify carries a single
//!     `#=NO-MATCH=#` line instead.
//!   - `#=WANT=# <note>` lines are human annotations (e.g. the ideal answer for
//!     a known misclassification). Never asserted -- documentation only.
//!
//! All three sentinels (and the `‹ ›` delimiters) are stripped before the log is
//! handed to the classifier, so the engine sees a pristine log.
//!
//! The marker records CURRENT behavior, like a snapshot. When a ruleset change
//! moves the match or changes its captures, the test fails; re-bless with:
//!
//!     UPDATE_FIXTURES=1 cargo test --test classify
//!
//! which rewrites each fixture to canonical form -- placing `#=MATCH=#` on the
//! line the classifier now lands on and drawing `‹ ›` around its live captures
//! (offsets are computed from the matching rule's regex and mapped back through
//! `log::strip_line` onto the raw line, so timestamps and ANSI don't throw the
//! delimiters off). A bad shift is glaring in the diff.

use log_classifier::engine::evaluate_ruleset;
use log_classifier::log::{strip_line, Log};
use log_classifier::rule::{Rule, RuleSet};
use std::fs;
use std::path::{Path, PathBuf};

const MATCH_PREFIX: &str = "#=MATCH=# ";
const NO_MATCH: &str = "#=NO-MATCH=#";
const WANT_PREFIX: &str = "#=WANT=#";
const CAP_OPEN: char = '‹';
const CAP_CLOSE: char = '›';

/// A fixture line, once its harness markers are stripped.
enum Item {
    /// A real log line (pristine: no prefix, no `‹ ›`).
    Log(String),
    /// A `#=WANT=#` annotation, preserved verbatim.
    Want(String),
}

/// Strip harness markers, yielding the fixture's real log lines (in order) and
/// its `#=WANT=#` notes. `#=NO-MATCH=#` is dropped.
fn parse_items(content: &str) -> Vec<Item> {
    content
        .lines()
        .filter_map(|line| {
            if let Some(rest) = line.strip_prefix(MATCH_PREFIX) {
                Some(Item::Log(rest.replace(CAP_OPEN, "").replace(CAP_CLOSE, "")))
            } else if line == NO_MATCH {
                None
            } else if line.starts_with(WANT_PREFIX) {
                Some(Item::Want(line.to_string()))
            } else {
                Some(Item::Log(line.to_string()))
            }
        })
        .collect()
}

/// Wrap each captured span of `bare` (a pristine raw log line) in `‹ ›`, exactly
/// mirroring how the engine derives captures: the whole match when the rule has
/// no capture groups, otherwise each (present) group. Capture offsets come from
/// re-running the rule on the cleaned line and are mapped back onto `bare` via
/// `strip_line`, so the delimiters land correctly even with a timestamp prefix
/// or ANSI codes in the way.
fn annotate(bare: &str, rule: &Rule) -> String {
    let (cleaned, map) = strip_line(bare);
    let caps = match rule.pattern.captures(&cleaned) {
        Some(c) => c,
        None => return bare.to_string(),
    };

    // (start, end) byte spans in the cleaned line, matching engine semantics.
    let spans: Vec<(usize, usize)> = if caps.len() == 1 {
        let m = caps.get(0).unwrap();
        vec![(m.start(), m.end())]
    } else {
        (1..caps.len())
            .filter_map(|i| caps.get(i).map(|m| (m.start(), m.end())))
            .collect()
    };

    // Turn spans into (raw_offset, is_open) marks; emit closes before opens at
    // the same offset so adjacent captures render as `›‹`.
    let mut marks: Vec<(usize, bool)> = Vec::new();
    for (s, e) in spans {
        marks.push((map[s], true));
        // Close just past the span's last kept byte, so trailing ANSI that was
        // stripped between this capture and the next kept char stays *outside*
        // the delimiters (map[e] would skip past it).
        let close = if e > s { map[e - 1] + 1 } else { map[s] };
        marks.push((close, false));
    }
    marks.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut out = String::with_capacity(bare.len() + marks.len() * 3);
    let mut mi = 0;
    for (idx, ch) in bare.char_indices() {
        while mi < marks.len() && marks[mi].0 == idx {
            out.push(if marks[mi].1 { CAP_OPEN } else { CAP_CLOSE });
            mi += 1;
        }
        out.push(ch);
    }
    while mi < marks.len() {
        out.push(if marks[mi].1 { CAP_OPEN } else { CAP_CLOSE });
        mi += 1;
    }
    out
}

/// Render a fixture into canonical form: `#=MATCH=#` (with `‹ ›` captures) on the
/// line the live classifier lands on, or a leading `#=NO-MATCH=#`. This is the
/// single source of truth -- assert mode checks the fixture already equals it,
/// update mode writes it.
fn render_canonical(content: &str) -> String {
    let items = parse_items(content);
    let log_text = items
        .iter()
        .filter_map(|i| match i {
            Item::Log(l) => Some(l.as_str()),
            Item::Want(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";

    let ruleset = RuleSet::new_from_config();
    let m = evaluate_ruleset(&ruleset, &Log::new(log_text));
    let target = m.as_ref().map(|m| m.line_number);
    let rule = m.map(|m| m.rule);

    let mut out: Vec<String> = Vec::new();
    if target.is_none() {
        out.push(NO_MATCH.to_string());
    }
    let mut log_line = 0;
    for item in items {
        match item {
            Item::Want(w) => out.push(w),
            Item::Log(l) => {
                log_line += 1;
                if Some(log_line) == target {
                    let annotated = annotate(&l, rule.as_ref().unwrap());
                    out.push(format!("{MATCH_PREFIX}{annotated}"));
                } else {
                    out.push(l);
                }
            }
        }
    }
    out.join("\n") + "\n"
}

/// Extract the marker line (`#=MATCH=#` or `#=NO-MATCH=#`) for a compact diff.
fn marker_of(content: &str) -> String {
    content
        .lines()
        .find(|l| l.starts_with(MATCH_PREFIX) || *l == NO_MATCH)
        .unwrap_or("(no marker)")
        .to_string()
}

fn fixture_paths() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/classify");
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "txt"))
        .collect();
    paths.sort();
    paths
}

#[test]
fn classify_fixtures() {
    let update = std::env::var_os("UPDATE_FIXTURES").is_some();
    let mut failures: Vec<String> = Vec::new();

    for path in fixture_paths() {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let content = fs::read_to_string(&path).unwrap();
        let canonical = render_canonical(&content);

        if update {
            if canonical != content {
                fs::write(&path, &canonical).unwrap();
            }
        } else if canonical != content {
            failures.push(format!(
                "{name}:\n  marked:  {}\n  current: {}",
                marker_of(&content),
                marker_of(&canonical)
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "classification changed (re-bless with `UPDATE_FIXTURES=1 cargo test --test classify`):\n{}",
        failures.join("\n")
    );
}
