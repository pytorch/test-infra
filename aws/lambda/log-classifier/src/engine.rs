use crate::log::Log;
use crate::rule::{Rule, RuleSet};
use crate::rule_match::Match;
use rayon::prelude::*;

/// Evaluate `rule` against `log`. Returns a `Match` if there was a successful
/// match, otherwise None.
pub fn evaluate_rule(rule: &Rule, log: &Log) -> Option<Match> {
    // Iterate in reverse order, as later log lines are more likely to be
    // interesting to us.
    for (line_number, line) in log.lines.iter().rev() {
        if let Some(captures) = rule.pattern.captures(line) {
            let captures = if captures.len() == 1 {
                // If there is only one capture, it means that the regex itself
                // had no capturing groups (since the first capture group is
                // always the whole match). In that case, just record the whole
                // match as a capture.
                vec![captures.get(0).unwrap().as_str().to_string()]
            } else {
                captures
                    .iter()
                    .skip(1) // the first capture is the whole match, so skip it
                    .flatten() // remove non-matching captures
                    .map(|c| c.as_str().to_string())
                    .collect()
            };

            return Some(Match {
                line_number: *line_number,
                rule: rule.clone(),
                captures,
            });
        }
    }
    None
}

/// Evaluate the ruleset against `log`. Returns the highest-priority match, or
/// None if no rule matched.
pub fn evaluate_ruleset(ruleset: &RuleSet, log: &Log) -> Option<Match> {
    ruleset
        .rules
        .par_iter()
        .flat_map(|rule| evaluate_rule(rule, log))
        .max_by(|a, b| a.rule.priority.cmp(&b.rule.priority))
}
