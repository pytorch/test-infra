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

impl Log {
    /// Create a log from a string, applying some preprocessing to make it
    /// easier to match against.
    pub fn new(log: String) -> Log {
        let mut lines = BTreeMap::new();
        let mut ignore_state = IgnoreStateMachine::new();

        // Do some preprocessing on the log lines.
        for (idx, raw_line) in log.lines().enumerate() {
            // GHA adds a timestamp to the front of every log. Strip it before matching.
            let line = TIMESTAMP_REGEX.replace(raw_line, "");

            // Strip ANSI escape codes that interfere with matching.
            let line = ESCAPE_CODE_REGEX.replace_all(&line, "");

            // If this line should be ignored, don't add it to the Log.
            if ignore_state.should_ignore(&line) {
                continue;
            }

            // Lines are 1-indexed!
            let line_number = idx + 1;
            lines.insert(line_number, line.into_owned());
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
