use crate::log::Log;
use crate::rule::Rule;
use serde::Serialize;

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
}

impl SerializedMatch {
    pub fn new(m: &Match, log: &Log) -> SerializedMatch {
        // Unwrap because we know this is a valid key (since the Log object is never mutated.)
        let line = log.lines.get(&m.line_number).unwrap();
        SerializedMatch {
            rule: m.rule.name.clone(),
            line: line.clone(),
            line_num: m.line_number,
            captures: m.captures.clone(),
        }
    }
}
