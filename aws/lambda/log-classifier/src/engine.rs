use crate::log::Log;
use crate::rule::{Rule, RuleSet};
use crate::rule_match::Match;
use rayon::prelude::*;
use std::cmp::min;

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

/// Evaluates a ruleset against all lines of a log, returning matching line numbers.
///
/// # Arguments
///
/// * `ruleset` - A reference to the RuleSet to evaluate.
/// * `log` - A reference to the Log to evaluate against.
///
/// # Returns
///
/// A vector of line numbers that match any rule in the ruleset.
/// Note: Each rule in ruleset can only match 1 line which is the last line that matches the rule.
pub fn evaluate_ruleset_all_lines(ruleset: &RuleSet, log: &Log) -> Vec<usize> {
    let matches: Vec<Match> = ruleset
        .rules
        .par_iter()
        .flat_map(|rule| evaluate_rule(rule, log))
        .collect();
    // combine captures into a single vector
    let mut lines = Vec::new();
    for m in matches {
        lines.push(m.line_number);
    }
    lines
}

/// Merges line numbers into chunks based on specified size constraints.
///
/// # Arguments
///
/// * `log` - A reference to the Log structure containing the lines.
/// * `line_numbers` - A vector of line numbers to be chunked.
/// * `min_context_padding` - The minimum size of each chunk.
/// * `max_chunk_size` - The maximum size of each chunk.
///
/// # Returns
///
/// A vector of tuples, where each tuple contains the start and end line numbers of a chunk.
/// The chunks contain a contiguous set of lines around the specified line numbers. We extend
/// the chunks by `min_context_padding` on both sides, up to the limits of the log which could
/// lead to overlapping chunks.
///
/// # Panics
///
/// This function will panic if:
/// * `min_context_padding` is greater than or equal to `max_chunk_size`.
/// * Any line number is less than 1 or greater than the number of lines in the log.
fn get_line_number_chunks(
    log: &Log,
    line_numbers: Vec<usize>,
    min_context_padding: usize,
    max_chunk_size: usize,
) -> Vec<(usize, usize)> {
    // throw user error if min_context_padding is greater than max_chunk_size
    if min_context_padding * 2 >= max_chunk_size {
        panic!("min_context_padding cannot be greater or equal to max_chunk_size");
    }

    // check if empty
    if line_numbers.is_empty() {
        return Vec::new();
    }

    // sort line numbers
    let mut line_numbers = line_numbers;
    line_numbers.sort();

    // assert length of log is at least last line number and no negative line numbers
    if *line_numbers.first().unwrap() < 1 || *line_numbers.last().unwrap() > log.lines.len() {
        panic!("line numbers must be within the range of the log");
    }

    // merge line numbers into chunks
    let mut merged_line_numbers = Vec::new();
    // as we add min_context_padding to both sides
    let effective_max_chunk_size = max_chunk_size - (min_context_padding * 2);
    let mut chunk_start = 0;
    let mut chunk_end = 0;
    for line_number in line_numbers {
        if chunk_start == 0 {
            chunk_start = line_number;
            chunk_end = line_number;
        } else if line_number - chunk_start < effective_max_chunk_size {
            chunk_end = line_number;
        } else {
            chunk_start = chunk_start.saturating_sub(min_context_padding).max(1);
            chunk_end = min(chunk_end + min_context_padding, log.lines.len());

            merged_line_numbers.push((chunk_start, chunk_end));
            chunk_start = line_number;
            chunk_end = line_number;
        }
    }
    // add remaining chunk
    merged_line_numbers.push((
        chunk_start.saturating_sub(min_context_padding).max(1),
        min(chunk_end + min_context_padding, log.lines.len()),
    ));

    // if there are chunks with the same start point keep the largest chunk and remove the rest
    // if there are chunks with the same end point keep the largest chunk and remove the rest
    // we make use of the fact that we add the chunks in order by starting point and this clumping
    // only really happens at the first and last indices

    let mut merged_line_numbers_filtered = Vec::new();
    let mut last_chunk = (0, 0);
    for chunk in merged_line_numbers {
        if chunk.0 == last_chunk.0 {
            if chunk.1 > last_chunk.1 {
                merged_line_numbers_filtered.pop();
                merged_line_numbers_filtered.push(chunk);
                last_chunk = chunk;
            }
        } else if chunk.1 == last_chunk.1 {
            if chunk.0 < last_chunk.0 {
                merged_line_numbers_filtered.pop();
                merged_line_numbers_filtered.push(chunk);
                last_chunk = chunk;
            }
        } else {
            merged_line_numbers_filtered.push(chunk);
            last_chunk = chunk;
        }
    }

    merged_line_numbers_filtered
}

/// Extracts snippets from a log based on specified line numbers and chunk sizes.
///
/// # Arguments
///
/// * `log` - A reference to the Log structure containing the lines.
/// * `line_numbers` - A vector of line numbers to extract snippets around.
/// * `min_context_padding` - The minimum size of the context padding.
/// * `max_chunk_size` - The maximum size of each chunk.
///
/// # Returns
///
/// A vector of strings, where each string is a snippet of log lines.
///
/// # Description
///
/// This function first calls `get_line_number_chunks` to group the specified line numbers
/// into chunks. It then extracts the log lines for each chunk, concatenating them into
/// a single string (snippet). Each line in the snippet is separated by a newline character.
///
/// If a line number in a chunk does not exist in the log, it is silently skipped.
pub fn get_snippets(
    log: &Log,
    line_numbers: Vec<usize>,
    min_context_padding: usize,
    max_chunk_size: usize,
) -> Vec<String> {
    let chunks = get_line_number_chunks(log, line_numbers, min_context_padding, max_chunk_size);
    chunks
        .iter()
        .map(|(start, end)| {
            let mut snippet = String::new();
            for i in *start..=*end {
                if let Some(line) = log.lines.get(&i) {
                    snippet.push_str(line);
                    snippet.push('\n');
                }
            }
            snippet
        })
        .collect()
}

#[cfg(test)]
mod test {
    use super::*;
    use assert_unordered::assert_eq_unordered;
    use insta::assert_snapshot;
    use std::fs;

    #[test]
    fn test_evaluate_ruleset_all_lines_single_match() {
        let mut ruleset = RuleSet::new();
        ruleset.add("test", r"^test");
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            "
            .into(),
        );
        let matches = evaluate_ruleset_all_lines(&ruleset, &log);
        assert_eq_unordered!(matches, [2].into());
    }

    #[test]
    fn test_evaluate_ruleset_all_lines_multiple_match() {
        let mut ruleset = RuleSet::new();
        ruleset.add("test", r"^test");
        ruleset.add("test_foo", r"^test foo");
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            "
            .into(),
        );
        let matches = evaluate_ruleset_all_lines(&ruleset, &log);
        assert_eq_unordered!(matches, [2, 1].into());
    }

    #[test]
    fn test_get_line_number_chunks_smoke_test() {
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            test baz\n\
            "
            .into(),
        );
        let line_numbers = vec![1, 2];
        let chunks = get_line_number_chunks(&log, line_numbers, 1, 3);
        assert_eq_unordered!(chunks, [(1, 3)].into());
    }

    #[test]
    fn test_get_line_number_chunks_no_padding() {
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            test baz\n\
            "
            .into(),
        );
        let line_numbers = vec![1, 3];
        let chunks = get_line_number_chunks(&log, line_numbers, 0, 2);
        assert_eq_unordered!(chunks, [(1, 1), (3, 3)].into());
    }

    #[test]
    fn test_get_line_number_chunks_multiple_chunks() {
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            test baz\n\
            test foo\n\
            test bar\n\
            test baz\n\
            "
            .into(),
        );
        let line_numbers = vec![1, 2, 4];
        let chunks = get_line_number_chunks(&log, line_numbers, 1, 3);
        assert_eq_unordered!(chunks, [(1, 3), (3, 5)].into());
    }

    #[test]
    fn test_get_line_number_chunks_singleton() {
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            test baz\n\
            test foo\n\
            test bar\n\
            test baz\n\
            "
            .into(),
        );
        let line_numbers = vec![1];
        let chunks = get_line_number_chunks(&log, line_numbers, 1, 3);
        assert_eq_unordered!(chunks, [(1, 2)].into());
    }

    #[test]
    fn test_get_line_number_chunks_empty() {
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            test baz\n\
            "
            .into(),
        );
        let line_numbers = vec![];
        let chunks = get_line_number_chunks(&log, line_numbers, 1, 3);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_get_line_number_chunks_overlap() {
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            test baz\n\
            test foo\n\
            test bar\n\
            test baz\n\
            "
            .into(),
        );
        let line_numbers = vec![1, 2, 3, 4, 5, 6];
        let chunks = get_line_number_chunks(&log, line_numbers, 2, 5);
        assert_eq_unordered!(chunks, [(1, 5), (2, 6)].into());
    }

    #[test]
    fn test_get_snippets() {
        let log = Log::new(
            "\
            test foo\n\
            test bar\n\
            test baz\n\
            test foo2\n\
            test bar2\n\
            test baz2\n\
            test foo3\n\
            test bar3\n\
            test baz3\n\
            "
            .into(),
        );
        let line_numbers = vec![1, 2, 3, 4, 5, 6, 7, 8, 9];
        let snippets = get_snippets(&log, line_numbers, 2, 5);
        assert_eq_unordered!(
            snippets,
            [
                "test foo\ntest bar\ntest baz\ntest foo2\ntest bar2\n",
                "test bar\ntest baz\ntest foo2\ntest bar2\ntest baz2\n",
                "test baz\ntest foo2\ntest bar2\ntest baz2\ntest foo3\n",
                "test foo2\ntest bar2\ntest baz2\ntest foo3\ntest bar3\n",
                "test bar2\ntest baz2\ntest foo3\ntest bar3\ntest baz3\n",
            ]
            .iter()
            .map(|&s| String::from(s))
            .collect()
        );
    }

    #[test]
    fn test_get_snippets_on_log() {
        // Read the input log file
        let log_content = fs::read_to_string("fixtures/error_log1.txt");
        let log = Log::new(log_content.unwrap());
        // Define the error line and number of lines for the snippet
        let error_line = Vec::from([4047]);
        let num_lines = 10;

        // Call the function
        let result = get_snippets(&log, error_line, num_lines / 2 - 1, num_lines);
        // length is 1
        assert_eq!(result.len(), 1);
        // Convert result to a string
        let result_string = result.join("\n");
        // Assert against the snapshot
        assert_snapshot!(result_string);
    }

    #[test]
    fn test_get_snippets_on_log_with_multiple_matches() {
        // Read the input log file
        let log_content = fs::read_to_string("fixtures/error_log_multiple_matches.txt");
        let log = Log::new(log_content.unwrap());
        // Define the error line and number of lines for the snippet
        let error_line = Vec::from([750, 779]);
        let num_lines = 15;

        // Call the function
        let result = get_snippets(&log, error_line, num_lines / 2 - 1, num_lines);
        // length is 2
        assert_eq!(result.len(), 2);
        // Convert result to a string
        let result_string = result.join("\n");
        // Assert against the snapshot
        assert_snapshot!(result_string);
    }
}
