use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::BTreeMap;

/// Representation of a single CI log for matching against.
#[derive(Debug)]
pub struct Log {
    /// Map of line number => line text. We use BTreeMap because we want:
    ///   - Reasonably efficient lookup by line number.
    ///   - Ordered traversal so that we can compute context ranges easily.
    ///   - Non-contiguous line numbers (e.g. if we skip some lines).
    pub lines: BTreeMap<usize, String>,
}

/// Matches ANSI escape sequences so that they can be stripped out of the log.
/// See: https://stackoverflow.com/questions/14693701/how-can-i-remove-the-ansi-escape-sequences-from-a-string-in-python
static ESCAPE_CODE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:\x1B[@-Z\\-_]|[\x80-\x9A\x9C-\x9F]|(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~])").unwrap()
});

/// Matches the ISO8601 timestamp that GitHub Actions preprends to each log line
static TIMESTAMP_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z ").unwrap());

/// Lines that are pure CI-wrapper boilerplate: they are always emitted when a
/// step fails but never describe the underlying failure. We drop them during
/// preprocessing so that matching falls through to the real error line.
static IGNORE_LINE_REGEXES: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"^##\[error\]Process completed with exit code \d+\.?$").unwrap(),
        Regex::new(r"\[OSDC\] Step script exited").unwrap(),
        Regex::new(r"^##\[error\]Executing the custom container implementation failed").unwrap(),
        Regex::new(r"^##\[error\]TypeError: Cannot read properties of null \(reading 'jobPod'\)")
            .unwrap(),
        // OSDC wrapper's cancellation notice; the real cause (if any) is above it.
        Regex::new(r"\[OSDC\] Step cancelled by GitHub Actions").unwrap(),
    ]
});

/// Strip the GHA timestamp prefix and ANSI escape codes from a single raw log
/// line, exactly as `Log::new` does before matching. Returns the cleaned line
/// plus a source map: `map[i]` is the byte offset in `raw` that cleaned byte `i`
/// came from, for `i` in `0..=cleaned.len()` (the final entry points just past
/// the last kept byte). The map lets callers translate a match/capture offset in
/// the cleaned line back to a position in the original raw line -- e.g. to
/// annotate the raw line in a test fixture.
pub fn strip_line(raw: &str) -> (String, Vec<usize>) {
    // The timestamp is an anchored, fixed-width prefix; drop it wholesale.
    let ts_len = TIMESTAMP_REGEX.find(raw).map(|m| m.end()).unwrap_or(0);
    let rest = &raw[ts_len..];

    // ANSI escape sequences are deleted wherever they appear (non-overlapping,
    // in order, as find_iter yields them).
    let deleted: Vec<(usize, usize)> = ESCAPE_CODE_REGEX
        .find_iter(rest)
        .map(|m| (m.start(), m.end()))
        .collect();

    let mut cleaned = String::with_capacity(rest.len());
    let mut map = Vec::with_capacity(rest.len() + 1);
    let mut i = 0;
    let mut di = 0;
    while i < rest.len() {
        if di < deleted.len() && i == deleted[di].0 {
            i = deleted[di].1; // skip the escape sequence
            di += 1;
            continue;
        }
        let ch = rest[i..].chars().next().unwrap();
        let clen = ch.len_utf8();
        for b in 0..clen {
            map.push(ts_len + i + b);
        }
        cleaned.push(ch);
        i += clen;
    }
    map.push(ts_len + rest.len());
    (cleaned, map)
}

impl Log {
    /// Create a log from a string, applying some preprocessing to make it
    /// easier to match against.
    pub fn new(log: String) -> Log {
        let mut lines = BTreeMap::new();
        let mut ignore_state = IgnoreStateMachine::new();

        // Do some preprocessing on the log lines.
        for (idx, raw_line) in log.lines().enumerate() {
            // Strip the GHA timestamp prefix and ANSI escape codes before matching.
            let (line, _map) = strip_line(raw_line);

            // Drop lines that match a known-boilerplate pattern before matching.
            if IGNORE_LINE_REGEXES.iter().any(|re| re.is_match(&line)) {
                continue;
            }

            // If this line should be ignored, don't add it to the Log.
            if ignore_state.should_ignore(&line) {
                continue;
            }

            // Lines are 1-indexed!
            let line_number = idx + 1;
            lines.insert(line_number, line);
        }

        Log { lines }
    }
}

/// Helper to manage the state for whether or not the matcher should be ignoring
/// the current line. We ignore matches against some regions of the logs are
/// known to be noisy or misleading.
#[derive(Debug)]
struct IgnoreStateMachine {
    is_ignoring: bool,
    start_ignore: Regex,
    stop_ignore: Regex,
}

impl IgnoreStateMachine {
    fn new() -> Self {
        let start_ignore =
            Regex::new(r"=================== sccache compilation log ===================").unwrap();
        let stop_ignore = Regex::new(r"=========== If your build fails, please take a look at the log above for possible reasons ===========").unwrap();
        Self {
            is_ignoring: false,
            start_ignore,
            stop_ignore,
        }
    }

    /// Check whether we should ignore the provided line, and advance the state
    /// machine one step.
    fn should_ignore(&mut self, line: &str) -> bool {
        if self.is_ignoring {
            if self.stop_ignore.is_match(line) {
                self.is_ignoring = false;
            }
            true
        } else {
            if self.start_ignore.is_match(line) {
                self.is_ignoring = true;
                true
            } else {
                false
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    const FAKE_TIMESTAMP: &str = "2024-07-08T16:59:08.1747875Z ";

    fn retained_lines(raw: &str) -> Vec<String> {
        Log::new(raw.to_string())
            .lines
            .into_values()
            .collect::<Vec<_>>()
    }

    #[test]
    fn ignore_regexes_match_their_targets() {
        // Exit code, with and without the trailing period.
        assert!(IGNORE_LINE_REGEXES[0].is_match("##[error]Process completed with exit code 1."));
        assert!(IGNORE_LINE_REGEXES[0].is_match("##[error]Process completed with exit code 128"));
        // OSDC wrapper (intentionally unanchored).
        assert!(IGNORE_LINE_REGEXES[1].is_match("[OSDC] Step script exited with code 1"));
        // Custom container implementation failure.
        assert!(IGNORE_LINE_REGEXES[2].is_match(
            "##[error]Executing the custom container implementation failed with exit code 1."
        ));
        // jobPod null-read TypeError.
        assert!(IGNORE_LINE_REGEXES[3]
            .is_match("##[error]TypeError: Cannot read properties of null (reading 'jobPod')"));
        // OSDC cancellation notice.
        assert!(IGNORE_LINE_REGEXES[4]
            .is_match("##[error][OSDC] Step cancelled by GitHub Actions (received SIGINT). ..."));
    }

    #[test]
    fn log_new_drops_ignored_boilerplate_lines() {
        let raw = format!(
            "{ts}##[error]Process completed with exit code 1.\n\
             {ts}[OSDC] Step script exited with code 1\n\
             {ts}##[error]Executing the custom container implementation failed with exit code 1.\n\
             {ts}##[error]TypeError: Cannot read properties of null (reading 'jobPod')\n\
             {ts}##[error]RuntimeError: real failure\n\
             {ts}OSError: boom\n",
            ts = FAKE_TIMESTAMP
        );
        assert_eq!(
            retained_lines(&raw),
            vec![
                "##[error]RuntimeError: real failure".to_string(),
                "OSError: boom".to_string(),
            ]
        );
    }

    #[test]
    fn log_new_keeps_lines_that_only_resemble_boilerplate() {
        let raw = format!(
            "{ts}##[error]TypeError: something real\n\
             {ts}some [OSDC] unrelated info line\n",
            ts = FAKE_TIMESTAMP
        );
        assert_eq!(
            retained_lines(&raw),
            vec![
                "##[error]TypeError: something real".to_string(),
                "some [OSDC] unrelated info line".to_string(),
            ]
        );
    }

    #[test]
    fn strip_line_maps_offsets_back_through_timestamp_and_ansi() {
        // Timestamp prefix (29 chars) + ANSI around "foo".
        let raw = "2024-07-08T16:59:08.1747875Z pre \x1b[4mfoo\x1b[0m bar";
        let (cleaned, map) = strip_line(raw);
        assert_eq!(cleaned, "pre foo bar");
        // Every cleaned byte maps back to the same character in the raw line.
        for (i, b) in cleaned.bytes().enumerate() {
            assert_eq!(raw.as_bytes()[map[i]], b);
        }
        // The capture-style span for "foo" maps back across the ANSI open code.
        // The tight raw span ends at the last kept byte (map[end-1]); map[end]
        // would skip forward past the trailing ANSI escape.
        let start = cleaned.find("foo").unwrap();
        let end = start + "foo".len();
        assert_eq!(&raw[map[start]..=map[end - 1]], "foo");
        // End sentinel points just past the last kept byte.
        assert_eq!(map.len(), cleaned.len() + 1);
    }

    #[test]
    fn ignore_line_regexes_compile() {
        // Forcing the Lazy to evaluate runs every Regex::new().unwrap(), which
        // would panic here if any pattern were malformed.
        assert_eq!(IGNORE_LINE_REGEXES.len(), 5);
    }
}
