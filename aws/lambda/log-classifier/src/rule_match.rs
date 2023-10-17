use crate::log::Log;
use crate::rule::Rule;
use serde::Serialize;

/// Set the maximum depth of the context stack
static CONTEXT_DEPTH: usize = 5;

/// Represents a successful match of a log line against a rule.
#[derive(Debug)]
pub struct Match {
    pub line_number: usize,
    pub rule: Rule,
    /// The capture groups in the regex pattern. If no capture groups were
    /// specified, this is the entire match.
    pub captures: Vec<String>,
}

/// The actual format that we insert to Rockset.
#[derive(Debug, Serialize)]
pub struct SerializedMatch {
    rule: String,
    line: String,
    line_num: usize,
    captures: Vec<String>,
    /// The optional context where this failure occurs. This is a free-form
    /// stack of strings that includes the last commands before the failure
    pub context: Vec<String>,
}

impl SerializedMatch {
    pub fn new(m: &Match, log: &Log) -> SerializedMatch {
        // Unwrap because we know this is a valid key (since the Log object is never mutated.)
        let line = log.lines.get(&m.line_number).unwrap();

        let mut context = Vec::with_capacity(CONTEXT_DEPTH);
        // NB: backtrack the log till we find the previous command. This relies
        // on GitHub console log convention to prefix a bash command with +. An
        // important note is that this only works for bash though, not Windows
        // PowerShell. But Windows support could be added later.
        for i in (1..=m.line_number).rev() {
            if context.len() == CONTEXT_DEPTH {
                break
            }

            let l = log.lines.get(&i).unwrap();
            if l.starts_with("+") {
                context.push(l.clone());
            }
        }

        SerializedMatch {
            rule: m.rule.name.clone(),
            line: line.clone(),
            line_num: m.line_number,
            captures: m.captures.clone(),
            context: context.clone(),
        }
    }
}
