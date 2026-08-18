mod prompts;

use crate::log::Log;
use crate::rule_match::SerializedMatch;
use aws_config::BehaviorVersion;
use aws_sdk_bedrockruntime::operation::converse::ConverseError;
use aws_sdk_bedrockruntime::operation::converse::ConverseOutput;
use aws_sdk_bedrockruntime::types::ContentBlock;
use aws_sdk_bedrockruntime::types::ConversationRole::User;
use aws_sdk_bedrockruntime::types::Message;
use aws_smithy_runtime_api;
use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_runtime_api::http::Response;
use prompts::FIND_ERROR_LINE_PROMPT;
use std::ops::Bound;
use tracing::{error, warn};

static AWS_BEDROCK_RULE_NAME: &str = "AWS Bedrock";

/// The model asked first, and the one asked only when the first gives an answer
/// that is not usable. Named constants because the model id ends up in the
/// emitted rule name, so tests assert against these rather than a copy.
static MODEL_ID_PRIMARY: &str = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
static MODEL_ID_SECONDARY: &str = "us.anthropic.claude-sonnet-4-6";

/// Upper bound on the whole rendered prompt handed to Bedrock, in bytes.
///
/// `num_lines` on its own does not bound the payload: 500 lines of verbose CI
/// output (stack traces, embedded base64, long compiler command lines) can be
/// megabytes, which Bedrock rejects with `ValidationException: prompt is too
/// long`. Even at one token per byte -- far worse than log text really
/// tokenizes -- this stays well inside the 200k-token context of both models
/// below. A typical 500-line window is a small fraction of it, so this only
/// clamps the pathological logs; it does not narrow the context window that
/// #8391 deliberately widened.
static MAX_PROMPT_BYTES: usize = 100 * 1024;

/// Validates and extracts an error line from the AI model output and matches it with the log.
///
/// # Arguments
///
/// * `ai_output` - A string slice containing the output from the AI model
/// * `log` - A reference to the Log structure containing the full log
///
/// # Returns
///
/// * `Some(String)` - If a valid error line is found in both the AI output and the log
/// * `None` - If no matching error line is found or if the AI output is invalid
///
/// # Details
///
/// This function performs two main steps:
/// 1. It extracts the content between <error_line> tags from the AI output.
/// 2. It searches for this extracted content in the log.
///
/// If both steps succeed, it returns the matching log line. Otherwise, it returns None.
fn validate_output_in_log(ai_output: &str, log: &Log) -> (usize, Option<String>) {
    // Extract content between <error_line> tags
    let start_tag = "<error_line>";
    let end_tag = "</error_line>";

    let extracted_error_line = ai_output.find(start_tag).and_then(|start_index| {
        ai_output[start_index + start_tag.len()..]
            .find(end_tag)
            .map(|end_index| {
                let content = &ai_output
                    [start_index + start_tag.len()..start_index + start_tag.len() + end_index];
                content.trim().to_string()
            })
    });

    // If no error line is extracted from AI output, return None
    let error_line = match extracted_error_line {
        // An empty answer is not an answer. `Log::new` keeps blank lines, so an
        // empty (or whitespace-only, since the content is trimmed) tag pair
        // would otherwise "match" the first blank line in the log, and
        // `handle()` would replace a perfectly good ruleset verdict with a
        // match whose line is the empty string.
        Some(line) if !line.is_empty() => line,
        _ => return (0, None),
    };

    // Search for the extracted error line in the log
    for (i, log_entry) in log.lines.iter() {
        if log_entry == &error_line {
            return (*i, Some(log_entry.to_string()));
        }
    }

    // If no matching line is found in the log, return None
    (0, None)
}

/// Pulls the assistant's text out of a Converse response.
///
/// Every step is optional in the wire format, so none of them can be
/// `unwrap`ed: a response can carry no `output`, or a non-`message` output.
/// Text blocks are joined rather than taking `content[0]`, because a model may
/// emit a reasoning block ahead of its answer -- in which case the first block
/// is not the text we want. They are joined with a newline so that two blocks
/// cannot splice into a token that appeared in neither.
fn response_text(response: &ConverseOutput) -> Option<String> {
    let message = response.output.as_ref()?.as_message().ok()?;
    let text = message
        .content
        .iter()
        .filter_map(|block| block.as_text().ok())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n");

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// The result of one model attempt.
enum Attempt {
    /// The model named a line that really exists in the log.
    Refined(SerializedMatch),
    /// The model answered, but the answer was not usable. Another model may do
    /// better on the same prompt -- this is the case the secondary exists for.
    Unusable,
    /// The Bedrock call itself failed. This ends the LLM path rather than
    /// retrying against the secondary: the failure modes here are an over-long
    /// prompt (which every model would reject identically) or an outage /
    /// timeout / throttle, where a second multi-second round trip on an
    /// already-failing path risks running `handle()` out of Lambda deadline
    /// before it can write the ruleset verdict to DynamoDB. Losing the
    /// refinement is cheap; losing that write is the bug being fixed.
    CallFailed,
}

async fn query_model(
    client: &aws_sdk_bedrockruntime::Client,
    log: &Log,
    input_text: &str,
    model_name: &str,
) -> Attempt {
    // A Bedrock failure must not take the whole invocation down with it:
    // `handle()` has already computed a ruleset verdict by this point and still
    // has to write it to DynamoDB, so anything that goes wrong here degrades to
    // "no LLM refinement" rather than panicking and discarding that verdict.
    let response = match make_bedrock_call(client, input_text, model_name).await {
        Ok(response) => response,
        Err(err) => {
            // Logged at error level, not swallowed: this used to be a panic,
            // which is what made it visible in the Lambda error metric.
            error!("bedrock: converse call to {model_name} failed: {err:?}");
            return Attempt::CallFailed;
        }
    };

    let ai_output = match response_text(&response) {
        Some(text) => text,
        None => {
            warn!("bedrock: {model_name} returned no text content block");
            return Attempt::Unusable;
        }
    };

    let (line_num, validation) = validate_output_in_log(&ai_output, log);
    match validation {
        None => Attempt::Unusable,
        Some(validation) => Attempt::Refined(SerializedMatch {
            rule: format!("{AWS_BEDROCK_RULE_NAME} {model_name}"),
            line: validation.clone(),
            captures: vec![validation],
            line_num,
            context: vec![],
        }),
    }
}

/// Makes a query to an AI model using the provided log snippet.
///
/// This function creates a log snippet, sends it to two different AI models,
/// and validates the output. If a valid response is found, it is returned.
///
/// # Arguments
///
/// * `log` - A reference to the Log structure containing the full log
/// * `error_line` - The line number of the error
/// * `num_lines` - The maximum number of lines to include in the log snippet
///
/// # Returns
///
/// An Option<String> containing the validated AI response and its line number
/// in the logs, or None if no valid response was found.
pub async fn make_query(
    log: &Log,
    error_line: &usize,
    num_lines: usize,
) -> Option<SerializedMatch> {
    let input_text = snippet_for_query(log, error_line, num_lines)?;

    // Built once here rather than per call inside `make_bedrock_call`, so the
    // primary and the secondary share it -- and so the fallthrough below can be
    // driven by a replayed client in tests.
    let config = aws_config::load_defaults(BehaviorVersion::v2024_03_28()).await;
    let client = aws_sdk_bedrockruntime::Client::new(&config);

    refine_with_models(&client, log, &input_text).await
}

/// The two-model fallthrough, split out from client construction so that tests
/// can drive the whole `Attempt` state machine against a replayed Bedrock
/// client -- which model gets asked, whether the secondary is tried at all, and
/// what goes on the wire.
async fn refine_with_models(
    client: &aws_sdk_bedrockruntime::Client,
    log: &Log,
    input_text: &str,
) -> Option<SerializedMatch> {
    match query_model(client, log, input_text, MODEL_ID_PRIMARY).await {
        Attempt::Refined(r) => Some(r),
        Attempt::CallFailed => None,
        Attempt::Unusable => match query_model(client, log, input_text, MODEL_ID_SECONDARY).await {
            Attempt::Refined(r) => Some(r),
            Attempt::Unusable | Attempt::CallFailed => None,
        },
    }
}

/// Builds the snippet handed to the model: the log lines around `error_line`,
/// bounded both by `num_lines` and by `max_bytes`.
///
/// The window is `[error_line - num_lines / 2, error_line + num_lines / 2]`
/// intersected with the log, matching what `get_snippets` produces for a single
/// line number -- plus the byte bound, which is the point. A line bound alone
/// does not bound the payload: a few hundred lines of verbose CI output can be
/// megabytes and get rejected by Bedrock as an over-long prompt.
///
/// The window grows outward from `error_line` itself rather than being trimmed
/// toward the middle of a pre-built string, so the line being explained is
/// always retained -- including when it sits within `num_lines / 2` of either
/// end of the log, where the window is clipped to one side and the matched line
/// is nowhere near the centre. Anchoring on the line NUMBER also avoids picking
/// the wrong occurrence when the same text repeats, which is the common case
/// for the `##[error]` catch-all that sends a log down this path.
///
/// Returns `None` if `error_line` is not in the log. A single line that busts
/// the budget on its own (minified output, one long base64 blob) is cut at the
/// last UTF-8 boundary that fits.
fn snippet_around(
    log: &Log,
    error_line: usize,
    num_lines: usize,
    max_bytes: usize,
) -> Option<String> {
    let anchor = log.lines.get(&error_line)?;

    // The anchor alone can bust the budget (minified output, one long base64
    // blob). Cut it directly rather than building the full string first: the
    // line can be megabytes, and there is nothing else that would fit anyway.
    if anchor.len() + 1 > max_bytes {
        return Some(truncate_on_char_boundary(anchor, max_bytes));
    }

    let half = num_lines / 2;
    let lo = error_line.saturating_sub(half).max(1);
    let hi = error_line.saturating_add(half);

    // Line numbers are sparse -- preprocessing drops boilerplate lines -- so
    // walk the map's actual keys outward rather than a numeric range.
    // `Excluded(error_line)` rather than `error_line + 1..=hi`, which would
    // panic (start > end) whenever `half` is 0, and overflow at `usize::MAX`.
    let mut before = log.lines.range(lo..error_line).rev().peekable();
    let mut after = log
        .lines
        .range((Bound::Excluded(error_line), Bound::Included(hi)))
        .peekable();

    let mut kept_before: Vec<&str> = Vec::new();
    let mut kept_after: Vec<&str> = Vec::new();
    // Each line costs its own bytes plus the '\n' it is joined with.
    let cost = |line: &str| line.len() + 1;
    let mut total = cost(anchor);

    loop {
        let mut grew = false;
        if let Some((_, line)) = after.peek() {
            if total + cost(line) <= max_bytes {
                total += cost(line);
                kept_after.push(line.as_str());
                after.next();
                grew = true;
            }
        }
        if let Some((_, line)) = before.peek() {
            if total + cost(line) <= max_bytes {
                total += cost(line);
                kept_before.push(line.as_str());
                before.next();
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }

    let mut out = String::with_capacity(total);
    for line in kept_before.iter().rev() {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(anchor);
    out.push('\n');
    for line in &kept_after {
        out.push_str(line);
        out.push('\n');
    }

    debug_assert!(out.len() <= max_bytes);
    Some(out)
}

/// Truncates `text` to at most `max_bytes`, backing off to the last UTF-8
/// character boundary that fits. Slicing a `str` off a boundary panics.
fn truncate_on_char_boundary(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text[..cut].to_string()
}

/// Renders the prompt that actually goes on the wire. Extracted so that the
/// byte budget can be asserted against the real rendering rather than against a
/// copy of it in a test -- the budget in `make_query` bounds the *snippet*, but
/// the limit Bedrock enforces is on the rendered prompt.
fn render_prompt(snippet: &str) -> String {
    FIND_ERROR_LINE_PROMPT.replace("{{LOG_SNIPPET}}", snippet)
}

/// How many bytes of log the snippet may spend: the prompt ceiling less the
/// template that gets wrapped around it. A function rather than an expression
/// at the call site so the tests bound the same number production does.
fn snippet_budget() -> usize {
    MAX_PROMPT_BYTES.saturating_sub(FIND_ERROR_LINE_PROMPT.len())
}

/// The snippet `make_query` will send, budget already applied. Named so that a
/// test can assert the bound `make_query` itself uses -- `make_query` builds a
/// real Bedrock client, so it cannot be driven over a replayed transport.
fn snippet_for_query(log: &Log, error_line: &usize, num_lines: usize) -> Option<String> {
    snippet_around(log, *error_line, num_lines, snippet_budget())
}

async fn make_bedrock_call(
    client: &aws_sdk_bedrockruntime::Client,
    input_text: &str,
    model_id: &str,
) -> Result<ConverseOutput, SdkError<ConverseError, Response>> {
    let prompt = render_prompt(input_text);

    let content_block = ContentBlock::Text(prompt);

    // The last `unwrap` on this path. It cannot fail today -- both required
    // fields are set right here -- but "cannot fail" is a property of generated
    // code that an SDK bump can change, and the point of this change is that a
    // Bedrock hiccup never costs the DynamoDB write. A construction failure is
    // reported as one, and `query_model` degrades to `CallFailed` like any
    // other.
    let prompt_message = match Message::builder().content(content_block).role(User).build() {
        Ok(message) => message,
        Err(err) => return Err(SdkError::construction_failure(err)),
    };

    let response = client
        .converse()
        .model_id(model_id)
        .messages(prompt_message)
        .send()
        .await?;

    Ok(response)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::log::Log;
    use std::fs;

    #[test]
    fn test_validate_output_in_log() {
        // Read the input log file
        let log_content = fs::read_to_string("fixtures/error_log1.txt");
        let log = Log::new(log_content.unwrap());
        // Define the error line and number of lines for the snippet
        let error_line = "<error_line>OSError: We couldn't connect to 'https://huggingface.co' to load this file, couldn't find it in the cached files and it looks like t5-small is not the path to a directory containing a file named config.json.</error_line>";
        let (_, validation_result) = validate_output_in_log(error_line, &log);
        // Assert is error_line
        assert_eq!(
            validation_result,
            Some("OSError: We couldn't connect to 'https://huggingface.co' to load this file, couldn't find it in the cached files and it looks like t5-small is not the path to a directory containing a file named config.json.".to_string())
        );
    }

    #[test]
    fn test_validate_output_in_log_bad_input() {
        // Read the input log file
        let log_content = fs::read_to_string("fixtures/error_log1.txt");
        let log = Log::new(log_content.unwrap());

        // neither lines exist per batim in the log.
        let error_line_too_long = "<error_line>##[error]Process completed with exit code 1. Now it doesn't exist</error_line>";
        let error_line2_too_short = "<error_line>##[error]Process.</error_line>";
        let error_line_no_tag = "##[error]Process completed with exit code 1.";
        let error_line_partial_tag1 = "<error_line>##[error]Process completed with exit code 1.";
        let error_line_partial_tag2 = "##[error]Process completed with exit code 1.</error_line>";
        let (_, validation_log_too_long) = validate_output_in_log(error_line_too_long, &log);
        // Assert is validation_log_too_long is None
        assert_eq!(validation_log_too_long, None);
        let (_, validation_log_too_short) = validate_output_in_log(error_line2_too_short, &log);
        // Assert is validation_log_too_short is None
        assert_eq!(validation_log_too_short, None);
        let (_, validation_log_no_tag) = validate_output_in_log(error_line_no_tag, &log);
        // Assert is validation_log_no_tag is None
        assert_eq!(validation_log_no_tag, None);
        let (_, validation_log_partial_tag1) =
            validate_output_in_log(error_line_partial_tag1, &log);
        // Assert is validation_log_partial_tag1 is None
        assert_eq!(validation_log_partial_tag1, None);
        let (_, validation_log_partial_tag2) =
            validate_output_in_log(error_line_partial_tag2, &log);
        // Assert is validation_log_partial_tag2 is None
        assert_eq!(validation_log_partial_tag2, None);
    }

    /// A log whose line `n` reads `"line <n>"`, padded to `width` bytes.
    fn log_of(count: usize, width: usize) -> Log {
        let body: String = (1..=count)
            .map(|n| format!("{:<w$}\n", format!("line {n}"), w = width))
            .collect();
        Log::new(body)
    }

    fn anchor_text(n: usize, width: usize) -> String {
        format!("{:<w$}", format!("line {n}"), w = width)
    }

    #[test]
    fn snippet_returns_none_when_the_line_is_missing() {
        let log = log_of(10, 20);
        assert_eq!(snippet_around(&log, 999, 500, 10_000), None);
    }

    #[test]
    fn snippet_under_budget_is_the_whole_window() {
        // 10 lines of 20 bytes plus a newline each = 210 bytes, well under
        // budget, and num_lines covers the whole log -- every line comes back.
        let log = log_of(10, 20);
        let out = snippet_around(&log, 5, 500, 10_000).unwrap();
        assert_eq!(
            out,
            log_of(10, 20)
                .lines
                .values()
                .fold(String::new(), |mut a, l| {
                    a.push_str(l);
                    a.push('\n');
                    a
                })
        );
    }

    #[test]
    fn snippet_respects_the_line_window() {
        // num_lines = 4 -> half = 2 -> lines 3..=7 around line 5.
        let log = log_of(20, 10);
        let out = snippet_around(&log, 5, 4, 10_000).unwrap();
        let got: Vec<&str> = out.lines().map(str::trim_end).collect();
        assert_eq!(got, vec!["line 3", "line 4", "line 5", "line 6", "line 7"]);
    }

    #[test]
    fn snippet_trims_to_the_byte_budget_around_the_anchor() {
        // 400 lines x 100 bytes; anchor line 200; budget fits exactly 50 lines.
        let log = log_of(400, 99);
        let out = snippet_around(&log, 200, 500, 5_000).unwrap();
        assert_eq!(out.len(), 5_000);
        // Each pass extends forward before backward, so of the 49 lines added
        // beside the anchor the forward side gets 25 and the backward 24:
        // lines 176..=225. Pinning the exact window (not just a length bound)
        // is what stops an empty or off-by-N result from passing.
        let expected: Vec<String> = (176..=225).map(|n| anchor_text(n, 99)).collect();
        let got: Vec<&str> = out.lines().collect();
        assert_eq!(got, expected);
    }

    #[test]
    fn snippet_keeps_an_anchor_at_the_very_first_line() {
        // A match in the first num_lines/2 lines is NOT centered -- the window
        // is clipped to the start of the log. Trimming toward the middle of a
        // pre-built string would drop exactly the line being explained.
        let log = log_of(400, 99);
        let out = snippet_around(&log, 1, 500, 5_000).unwrap();
        let got: Vec<&str> = out.lines().collect();
        assert_eq!(got.first().map(|l| l.trim_end()), Some("line 1"));
        // ...and it still carries real context after it, not just the anchor.
        assert_eq!(got.len(), 50);
        assert_eq!(got.last().map(|l| l.trim_end()), Some("line 50"));
    }

    #[test]
    fn snippet_keeps_an_anchor_at_the_very_last_line() {
        let log = log_of(400, 99);
        let out = snippet_around(&log, 400, 500, 5_000).unwrap();
        let got: Vec<&str> = out.lines().collect();
        assert_eq!(got.last().map(|l| l.trim_end()), Some("line 400"));
        assert_eq!(got.len(), 50);
        assert_eq!(got.first().map(|l| l.trim_end()), Some("line 351"));
    }

    #[test]
    fn snippet_anchors_on_the_line_number_not_the_text() {
        // The catch-all rule that sends a log down the LLM path matches a line
        // that repeats throughout the log, and the engine picks the LAST one.
        // Anchoring by text would build the window around the FIRST occurrence,
        // thousands of lines away from the actual failure.
        let mut body = String::new();
        for _ in 0..300 {
            // A line that repeats verbatim throughout the log. (Deliberately
            // not an `##[error]` line: preprocessing drops those as
            // boilerplate, so they never reach the snippet builder at all.)
            body.push_str("FAILED tests/test_foo.py::test_bar\n");
        }
        body.push_str("the real tail\n");
        let log = Log::new(body);
        let last_error_line = 300;

        let out = snippet_around(&log, last_error_line, 8, 10_000).unwrap();
        let got: Vec<&str> = out.lines().collect();
        // Window is [296, 304] clipped to the log's 301 lines, so the tail line
        // must be present -- it only is if we anchored on line 300, not line 1.
        assert!(
            got.contains(&"the real tail"),
            "anchored on the wrong occurrence: {got:?}"
        );
    }

    #[test]
    fn snippet_skips_gaps_left_by_dropped_boilerplate() {
        // Preprocessing drops lines, leaving holes in the key space; the window
        // must walk real keys, not a dense numeric range.
        let mut log = log_of(20, 10);
        for n in [4, 5, 6, 7] {
            log.lines.remove(&n);
        }
        let out = snippet_around(&log, 8, 8, 10_000).unwrap();
        let got: Vec<&str> = out.lines().map(str::trim_end).collect();
        // [4, 12] intersected with the surviving keys.
        assert_eq!(
            got,
            vec!["line 8", "line 9", "line 10", "line 11", "line 12"]
        );
    }

    #[test]
    fn snippet_cuts_a_single_oversized_line_at_a_char_boundary() {
        // The anchor alone busts the budget, so it has to be cut mid-line.
        // Distinct bytes make prefix-truncation observable.
        let body: String = (0..5_000).map(|n| format!("{}", n % 10)).collect();
        let log = Log::new(format!(
            "{body}
"
        ));
        let out = snippet_around(&log, 1, 500, 1_000).unwrap();
        assert_eq!(out.len(), 1_000);
        assert_eq!(out, body[..1_000]);
    }

    #[test]
    fn snippet_cuts_multibyte_text_on_a_char_boundary() {
        // Slicing a String off a char boundary panics; the budget deliberately
        // lands mid-character (each 'é' is 2 bytes, so byte 1001 splits one).
        let body: String = "é".repeat(5_000);
        let log = Log::new(format!(
            "{body}
"
        ));
        let out = snippet_around(&log, 1, 500, 1_001).unwrap();
        assert_eq!(out.len(), 1_000);
        assert_eq!(out.chars().count(), 500);
        assert!(out.chars().all(|c| c == 'é'));
    }

    #[test]
    fn snippet_with_a_zero_budget_does_not_panic() {
        let log = log_of(10, 20);
        assert_eq!(snippet_around(&log, 5, 500, 0), Some(String::new()));
    }

    #[test]
    fn snippet_with_a_degenerate_line_window_does_not_panic() {
        // half == 0 makes the forward range start > end, which panics if it is
        // written as `error_line + 1..=hi` instead of an excluded bound.
        let log = log_of(10, 20);
        for num_lines in [0, 1] {
            let out = snippet_around(&log, 5, num_lines, 10_000).unwrap();
            assert_eq!(out.trim_end(), "line 5");
        }
    }

    #[test]
    fn snippet_budget_counts_bytes_not_lines() {
        // Variable-width lines: a byte budget and a line budget pick different
        // windows here, so this fails against an implementation that silently
        // caps on line count instead.
        let mut body = String::new();
        for n in 1..=40 {
            // Lines 1-20 are short; 21-40 are long.
            let width = if n <= 20 { 10 } else { 400 };
            body.push_str(&format!("{:<w$}\n", format!("line {n}"), w = width));
        }
        let log = Log::new(body);

        // Anchor in the long region: only a handful of 401-byte lines fit.
        let out = snippet_around(&log, 30, 500, 2_000).unwrap();
        assert!(out.len() <= 2_000);
        let got: Vec<&str> = out.lines().map(str::trim_end).collect();
        assert!(got.contains(&"line 30"));
        assert_eq!(
            got.len(),
            4,
            "byte budget should admit 4 long lines: {got:?}"
        );
    }

    /// Wraps `output` in an otherwise-minimal Converse response.
    fn converse_response(
        output: Option<aws_sdk_bedrockruntime::types::ConverseOutput>,
    ) -> ConverseOutput {
        ConverseOutput::builder()
            .set_output(output)
            .stop_reason(aws_sdk_bedrockruntime::types::StopReason::EndTurn)
            .build()
            .unwrap()
    }

    #[test]
    fn response_text_returns_none_instead_of_panicking_on_empty_output() {
        // The shape that used to panic at `.output.unwrap()`: Bedrock returned
        // a response, but with no output payload.
        assert_eq!(response_text(&converse_response(None)), None);
    }

    #[test]
    fn response_text_returns_none_on_message_with_no_content() {
        // The shape that used to panic at `.content[0]` (index out of bounds).
        let message = Message::builder()
            .role(User)
            .set_content(Some(vec![]))
            .build()
            .unwrap();
        let response = converse_response(Some(
            aws_sdk_bedrockruntime::types::ConverseOutput::Message(message),
        ));
        assert_eq!(response_text(&response), None);
    }

    #[test]
    fn response_text_extracts_a_text_block() {
        let message = Message::builder()
            .role(User)
            .content(ContentBlock::Text("<error_line>boom</error_line>".into()))
            .build()
            .unwrap();
        let response = converse_response(Some(
            aws_sdk_bedrockruntime::types::ConverseOutput::Message(message),
        ));
        assert_eq!(
            response_text(&response),
            Some("<error_line>boom</error_line>".to_string())
        );
    }

    #[test]
    fn response_text_joins_multiple_text_blocks_with_a_newline() {
        // Joining, not concatenating: bare concatenation could splice the tail
        // of one block into the head of the next and form a token that was in
        // neither -- including a spurious `<error_line>` tag.
        let message = Message::builder()
            .role(User)
            .content(ContentBlock::Text("<error_li".into()))
            .content(ContentBlock::Text("ne>boom</error_line>".into()))
            .build()
            .unwrap();
        let response = converse_response(Some(
            aws_sdk_bedrockruntime::types::ConverseOutput::Message(message),
        ));
        assert_eq!(
            response_text(&response),
            Some("<error_li\nne>boom</error_line>".to_string())
        );
    }

    #[test]
    fn response_text_skips_a_leading_non_text_block() {
        // A model that emits a reasoning/cache block ahead of its answer must
        // not read as "no text": taking content[0] would drop the answer and
        // waste a call on the secondary model.
        let message = Message::builder()
            .role(User)
            .content(ContentBlock::CachePoint(
                aws_sdk_bedrockruntime::types::CachePointBlock::builder()
                    .r#type(aws_sdk_bedrockruntime::types::CachePointType::Default)
                    .build()
                    .unwrap(),
            ))
            .content(ContentBlock::Text("<error_line>boom</error_line>".into()))
            .build()
            .unwrap();
        let response = converse_response(Some(
            aws_sdk_bedrockruntime::types::ConverseOutput::Message(message),
        ));
        assert_eq!(
            response_text(&response),
            Some("<error_line>boom</error_line>".to_string())
        );
    }

    // ---- The byte budget itself -------------------------------------------
    //
    // `make_query` budgets the SNIPPET, but the limit Bedrock enforces is on
    // the RENDERED prompt. Nothing above connects the two.

    #[test]
    fn prompt_template_has_exactly_one_snippet_placeholder() {
        // `make_bedrock_call` renders with `str::replace`, which substitutes
        // EVERY occurrence, while `make_query` subtracts the template length
        // exactly once. A second placeholder would silently send the snippet
        // twice and blow the budget with no error anywhere.
        assert_eq!(FIND_ERROR_LINE_PROMPT.matches("{{LOG_SNIPPET}}").count(), 1);
    }

    #[test]
    fn prompt_template_leaves_a_usable_snippet_budget() {
        // The budget is a `saturating_sub`. If the template ever grew toward
        // MAX_PROMPT_BYTES the budget would silently shrink -- at the limit to
        // 0, so every snippet becomes the empty string and the LLM path keeps
        // paying for calls that can never say anything, quietly and with no
        // error metric. Pin a floor that means something rather than a ratio:
        // 64 KiB is comfortably more log than the 500-line window usually is.
        const MIN_SNIPPET_BYTES: usize = 64 * 1024;
        assert!(
            FIND_ERROR_LINE_PROMPT.len() + MIN_SNIPPET_BYTES <= MAX_PROMPT_BYTES,
            "a {}-byte template leaves only {} bytes for the log, under the \
             {MIN_SNIPPET_BYTES}-byte floor",
            FIND_ERROR_LINE_PROMPT.len(),
            MAX_PROMPT_BYTES.saturating_sub(FIND_ERROR_LINE_PROMPT.len()),
        );
    }

    #[test]
    fn rendered_prompt_stays_within_max_prompt_bytes() {
        // The end-to-end property: run the exact arithmetic `make_query` runs,
        // on a log far too big for the budget, and measure what actually goes
        // on the wire -- through `render_prompt`, the same function
        // `make_bedrock_call` uses, not a copy of it. This is the assertion
        // that says `ValidationException: prompt is too long` cannot come back.
        const WIDTH: usize = 500;
        let log = log_of(2_000, WIDTH);
        let budget = snippet_budget();
        let snippet = snippet_around(&log, 1_000, 500, budget).unwrap();

        // The BYTE bound is what binds here, not the line bound: the full
        // num_lines=500 window is 501 lines of 501 bytes, ~251 KB. Pin the
        // exact number of lines the budget admits -- `<= budget` alone would
        // also hold for a degenerate empty snippet.
        let cost_per_line = WIDTH + 1;
        assert_eq!(snippet.lines().count(), budget / cost_per_line);
        assert!(
            snippet.lines().count() < 501,
            "the line bound must not be the binding one"
        );
        // ...and the snippet really fills the budget: less than one line spare.
        assert!(budget - snippet.len() < cost_per_line);

        let rendered = render_prompt(&snippet);
        assert!(
            rendered.len() <= MAX_PROMPT_BYTES,
            "rendered prompt is {} bytes, over the {MAX_PROMPT_BYTES}-byte budget",
            rendered.len()
        );
    }

    #[test]
    fn snippet_window_matches_the_get_snippets_window_it_replaced() {
        // The byte bound is the intended change; the LINE window is meant to be
        // the same one `get_snippets` produced at the call site this replaced
        // (`min_context_padding = num_lines / 2`, `max_chunk_size =
        // num_lines + 1`). With the byte bound lifted the two must agree
        // exactly, including at the clipped ends -- otherwise this quietly
        // narrows the context that #8391 deliberately widened.
        let dense = log_of(400, 20);

        // Preprocessing drops lines, so keys are sparse and the highest key
        // exceeds `lines.len()` -- the case where a dense numeric walk and a
        // key walk diverge. `get_snippets` clamps its window to the highest
        // KEY, so the two must still agree.
        let mut sparse = log_of(400, 20);
        for n in (2..=400).step_by(3) {
            sparse.lines.remove(&n);
        }
        assert!(sparse.lines.len() < 400);
        assert_eq!(sparse.lines.keys().next_back(), Some(&400));

        let num_lines = 100;
        for (label, log) in [("dense", &dense), ("sparse", &sparse)] {
            for anchor in [1, 3, 51, 199, 351, 400] {
                if !log.lines.contains_key(&anchor) {
                    continue;
                }
                let old =
                    crate::engine::get_snippets(log, vec![anchor], num_lines / 2, num_lines + 1);
                assert_eq!(old.len(), 1, "{label} anchor {anchor}");
                let new = snippet_around(log, anchor, num_lines, usize::MAX).unwrap();
                assert_eq!(
                    new, old[0],
                    "{label}: window differs from get_snippets at {anchor}"
                );
            }
        }
    }

    #[test]
    fn snippet_returns_none_for_line_zero_rather_than_panicking() {
        // Line numbers are 1-indexed, so 0 is never a key. The early return is
        // what keeps 0 out of `range(lo..error_line)`, which panics on
        // start > end once `lo` is clamped up to 1.
        let log = log_of(10, 20);
        assert_eq!(snippet_around(&log, 0, 500, 10_000), None);
    }

    // ---- truncate_on_char_boundary ----------------------------------------

    #[test]
    fn truncate_on_char_boundary_is_a_noop_at_or_under_the_limit() {
        assert_eq!(truncate_on_char_boundary("héllo", 100), "héllo");
        assert_eq!(truncate_on_char_boundary("héllo", "héllo".len()), "héllo");
    }

    #[test]
    fn truncate_on_char_boundary_backs_off_a_whole_character() {
        // 'é' is two bytes, so a cut at byte 2 splits it and must back off to
        // byte 1. Slicing a `str` off a boundary panics rather than erroring.
        assert_eq!(truncate_on_char_boundary("aéb", 2), "a");
        assert_eq!(truncate_on_char_boundary("aéb", 3), "aé");
        // A budget smaller than the first character yields "", not a panic.
        assert_eq!(truncate_on_char_boundary("é", 1), "");
    }

    // ---- validate_output_in_log: the line NUMBER --------------------------
    //
    // Every pre-existing test discards this value with `_`, but it is what
    // `SerializedMatch.line_num` carries and what HUD / Dr. CI highlight.

    #[test]
    fn validate_output_reports_the_line_number_of_the_match() {
        let log = log_of(10, 0);
        let (line_num, validation) =
            validate_output_in_log("<error_line>line 7</error_line>", &log);
        assert_eq!(line_num, 7);
        assert_eq!(validation, Some("line 7".to_string()));
    }

    #[test]
    fn validate_output_rejects_an_empty_error_line() {
        // A model that emits the tags with nothing between them would otherwise
        // "match" the first blank line in the log -- `Log::new` keeps blank
        // lines -- and `handle()` would then REPLACE the ruleset verdict with a
        // match whose line is the empty string, which reads on HUD as "the
        // classifier had nothing to say". An empty answer must fall through.
        let log = Log::new("first\n\nthird\n".to_string());
        assert_eq!(log.lines.get(&2).map(String::as_str), Some(""));

        let (line_num, validation) = validate_output_in_log("<error_line></error_line>", &log);
        assert_eq!(validation, None);
        assert_eq!(line_num, 0);

        // Whitespace-only is the same case: the content is trimmed first.
        let (_, whitespace) = validate_output_in_log("<error_line>   </error_line>", &log);
        assert_eq!(whitespace, None);
    }

    // ---- make_query -------------------------------------------------------

    #[tokio::test]
    async fn make_query_returns_none_when_the_line_is_not_in_the_log() {
        // Under the old `get_snippets` call this was a PANIC, not a None:
        // `get_line_number_chunks` panics outright on a line number past the
        // highest key. That is the second panic this change removed, and the
        // only `make_query` path reachable without a Bedrock client.
        //
        // This asserts the return value, and that it is reached without ever
        // constructing a Bedrock client: `snippet_around`'s `?` short-circuits
        // ahead of `refine_with_models`. The `Attempt` state machine past that
        // point is covered against a replayed client below.
        let log = log_of(10, 20);
        assert!(make_query(&log, &999, 500).await.is_none());
    }

    // ---- The LLM path, against a replayed Bedrock -------------------------
    //
    // Everything above stops at the edge of the network. These drive the real
    // SDK client -- its own request serialization and response parsing -- over
    // a fake transport, which is the only way to assert the two things the
    // incident was actually about: that a Bedrock failure cannot take the
    // invocation down, and that what goes on the wire respects the budget.
    //
    // The transport is a hand-rolled `HttpConnector` rather than smithy's
    // `StaticReplayClient`, which lives behind a `test-util` feature that would
    // add a dependency tree to a lambda crate for ~40 lines of queue.

    use aws_sdk_bedrockruntime::config::{Credentials, Region};
    use aws_smithy_runtime_api::client::http::{
        http_client_fn, HttpConnector, HttpConnectorFuture, SharedHttpConnector,
    };
    use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
    use aws_smithy_runtime_api::http::StatusCode;
    use aws_smithy_types::body::SdkBody;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// One request the classifier actually put on the wire.
    #[derive(Debug, Clone)]
    struct Sent {
        /// Carries the model id -- Converse addresses the model by URI path,
        /// not in the body, so this is the only evidence of WHICH model was
        /// asked.
        uri: String,
        body: String,
    }

    impl Sent {
        /// Whether this request was addressed to `model_id`. The id is
        /// percent-encoded into the path, so match on the encoded form.
        fn went_to(&self, model_id: &str) -> bool {
            self.uri.contains(&model_id.replace(':', "%3A"))
        }
    }

    /// Hands back canned HTTP responses in order and records what was sent.
    #[derive(Debug, Clone)]
    struct ReplayBedrock {
        queued: Arc<Mutex<VecDeque<(u16, String)>>>,
        sent: Arc<Mutex<Vec<Sent>>>,
    }

    impl ReplayBedrock {
        fn new(responses: Vec<(u16, String)>) -> Self {
            Self {
                queued: Arc::new(Mutex::new(responses.into_iter().collect())),
                sent: Arc::new(Mutex::new(Vec::new())),
            }
        }

        /// The requests that actually left, in order.
        fn sent(&self) -> Vec<Sent> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl HttpConnector for ReplayBedrock {
        fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
            // `expect` rather than a default: a streaming body would record as
            // empty and quietly weaken every assertion made on it below.
            let body = String::from_utf8_lossy(
                request
                    .body()
                    .bytes()
                    .expect("a Converse request body is buffered, not streaming"),
            )
            .into_owned();
            self.sent.lock().unwrap().push(Sent {
                uri: request.uri().to_string(),
                body,
            });

            let (status, payload) = self
                .queued
                .lock()
                .unwrap()
                .pop_front()
                // A call the test did not plan for is the failure being looked
                // for (e.g. a secondary attempt after `CallFailed`), so say so
                // rather than returning something plausible.
                .expect("bedrock was called more times than the test queued responses for");

            HttpConnectorFuture::ready(Ok(HttpResponse::new(
                StatusCode::try_from(status).unwrap(),
                SdkBody::from(payload),
            )))
        }
    }

    /// A real `aws_sdk_bedrockruntime::Client` wired to a replayed transport.
    ///
    /// Retries are disabled so that the recorded request count means "attempts
    /// the classifier chose to make" rather than "attempts the SDK made".
    fn replay_bedrock(
        responses: Vec<(u16, String)>,
    ) -> (aws_sdk_bedrockruntime::Client, ReplayBedrock) {
        let replay = ReplayBedrock::new(responses);
        let transport = replay.clone();
        let config = aws_sdk_bedrockruntime::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new("ak", "sk", None, None, "test"))
            .retry_config(aws_sdk_bedrockruntime::config::retry::RetryConfig::disabled())
            .http_client(http_client_fn(move |_, _| {
                SharedHttpConnector::new(transport.clone())
            }))
            .build();
        (aws_sdk_bedrockruntime::Client::from_conf(config), replay)
    }

    /// A 200 carrying `text` as the assistant's single content block.
    fn answers(text: &str) -> (u16, String) {
        (
            200,
            serde_json::json!({
                "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
                "stopReason": "end_turn"
            })
            .to_string(),
        )
    }

    /// The incident's own error: Bedrock refusing an over-long prompt.
    fn prompt_too_long() -> (u16, String) {
        (
            400,
            serde_json::json!({
                "__type": "ValidationException",
                "message": "Input is too long for requested model."
            })
            .to_string(),
        )
    }

    /// Digs the prompt back out of a recorded Converse request body.
    fn prompt_sent(request_body: &str) -> String {
        let parsed: serde_json::Value = serde_json::from_str(request_body).unwrap();
        parsed["messages"][0]["content"][0]["text"]
            .as_str()
            .expect("a Converse request carries one text content block")
            .to_string()
    }

    #[tokio::test]
    async fn a_bedrock_failure_yields_no_refinement_instead_of_panicking() {
        // THE regression test for this PR. Before it, the `.unwrap()` chain in
        // `query_model` panicked on any `Err` from Bedrock, which unwound out of
        // `handle()` before it could write the ruleset verdict to DynamoDB --
        // so a Bedrock hiccup cost the classification entirely, not just the
        // LLM refinement of it.
        let log = log_of(10, 20);
        let (client, replay) = replay_bedrock(vec![prompt_too_long()]);

        let refined = refine_with_models(&client, &log, "a snippet").await;

        assert!(refined.is_none());
        // ...and the secondary was NOT tried: `CallFailed` deliberately ends the
        // path, because a second multi-second round trip on an already-failing
        // call risks the Lambda deadline that the DynamoDB write needs.
        let sent = replay.sent();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].went_to(MODEL_ID_PRIMARY));
    }

    #[tokio::test]
    async fn a_bedrock_server_error_also_degrades_quietly() {
        // The other half of `CallFailed`: an outage or throttle rather than a
        // rejected prompt. Same contract -- no panic, no secondary.
        let log = log_of(10, 20);
        let (client, replay) = replay_bedrock(vec![(
            500,
            r#"{"__type":"InternalServerException","message":"oops"}"#.to_string(),
        )]);

        assert!(refine_with_models(&client, &log, "a snippet")
            .await
            .is_none());
        let sent = replay.sent();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].went_to(MODEL_ID_PRIMARY));
    }

    #[tokio::test]
    async fn a_usable_primary_answer_is_returned_without_asking_the_secondary() {
        let log = log_of(10, 0);
        let target = anchor_text(4, 0);
        let (client, replay) =
            replay_bedrock(vec![answers(&format!("<error_line>{target}</error_line>"))]);

        let refined = refine_with_models(&client, &log, "a snippet")
            .await
            .expect("a line that exists in the log is a usable answer");

        assert_eq!(refined.line, target);
        assert_eq!(refined.line_num, 4);
        assert_eq!(
            refined.rule,
            format!("{AWS_BEDROCK_RULE_NAME} {MODEL_ID_PRIMARY}")
        );
        // The rule name above is built from the model argument; this is the
        // independent check that the request really went to that model.
        let sent = replay.sent();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].went_to(MODEL_ID_PRIMARY));
    }

    #[tokio::test]
    async fn an_unusable_primary_answer_falls_through_to_the_secondary() {
        // `Unusable` is the case the second model exists for: the call worked,
        // the model just named a line that is not in the log.
        let log = log_of(10, 0);
        let target = anchor_text(7, 0);
        let (client, replay) = replay_bedrock(vec![
            answers("<error_line>a line that is not in the log</error_line>"),
            answers(&format!("<error_line>{target}</error_line>")),
        ]);

        let refined = refine_with_models(&client, &log, "a snippet")
            .await
            .expect("the secondary's answer is usable");

        assert_eq!(refined.line, target);
        // The emitted rule names the model that actually answered.
        assert_eq!(
            refined.rule,
            format!("{AWS_BEDROCK_RULE_NAME} {MODEL_ID_SECONDARY}")
        );
        let sent = replay.sent();
        assert_eq!(sent.len(), 2);
        // The primary really was asked first and the secondary second -- the
        // model is addressed by URI, so the rule name alone would not show a
        // fallthrough that asked the same model twice. The negative half keeps
        // `went_to` honest: a predicate that matched anything would satisfy the
        // positive assertions alone.
        assert!(sent[0].went_to(MODEL_ID_PRIMARY));
        assert!(!sent[0].went_to(MODEL_ID_SECONDARY));
        assert!(sent[1].went_to(MODEL_ID_SECONDARY));
        assert!(!sent[1].went_to(MODEL_ID_PRIMARY));
        // Both models were asked the same question.
        assert_eq!(prompt_sent(&sent[0].body), prompt_sent(&sent[1].body));
    }

    #[tokio::test]
    async fn both_models_unusable_yields_no_refinement() {
        let log = log_of(10, 20);
        let (client, replay) = replay_bedrock(vec![
            answers("<error_line>not in the log</error_line>"),
            answers("no tags at all"),
        ]);

        assert!(refine_with_models(&client, &log, "a snippet")
            .await
            .is_none());
        assert_eq!(replay.sent().len(), 2);
    }

    #[tokio::test]
    async fn a_secondary_that_fails_after_an_unusable_primary_still_degrades() {
        let log = log_of(10, 20);
        let (client, replay) = replay_bedrock(vec![
            answers("<error_line>not in the log</error_line>"),
            prompt_too_long(),
        ]);

        assert!(refine_with_models(&client, &log, "a snippet")
            .await
            .is_none());
        assert_eq!(replay.sent().len(), 2);
    }

    #[tokio::test]
    async fn an_empty_response_body_is_unusable_rather_than_a_panic() {
        // `response_text` is unit-tested against hand-built types above; this
        // drives the same case through the SDK's real deserializer, which is
        // what the old `.output.unwrap().as_message().unwrap()` chain sat on.
        let log = log_of(10, 0);
        let target = anchor_text(2, 0);
        let (client, replay) = replay_bedrock(vec![
            (200, r#"{"stopReason":"end_turn"}"#.to_string()),
            answers(&format!("<error_line>{target}</error_line>")),
        ]);

        let refined = refine_with_models(&client, &log, "a snippet").await;

        // A response with no `output` at all is an answer we cannot use, so the
        // secondary gets its turn -- not a panic, and not a silent give-up.
        assert_eq!(refined.map(|r| r.line), Some(target));
        assert_eq!(replay.sent().len(), 2);
    }

    #[tokio::test]
    async fn the_prompt_that_reaches_bedrock_stays_within_the_byte_budget() {
        // `rendered_prompt_stays_within_max_prompt_bytes` asserts this against
        // `render_prompt`. This asserts it against the bytes that actually go
        // out through the SDK -- the measurement Bedrock's
        // `ValidationException: prompt is too long` was made against.
        const WIDTH: usize = 4_000;
        let log = log_of(2_000, WIDTH); // ~8 MB, ~80x the budget
        let snippet = snippet_around(&log, 1_000, 500, snippet_budget()).unwrap();

        // Neither model can place this answer, so both get asked -- which is
        // what we want here: the bound has to hold on the secondary's prompt
        // too, not just the primary's.
        let (client, replay) = replay_bedrock(vec![
            answers("<error_line>not in the log</error_line>"),
            answers("<error_line>not in the log</error_line>"),
        ]);
        let _ = refine_with_models(&client, &log, &snippet).await;

        let sent = replay.sent();
        assert_eq!(sent.len(), 2);
        for Sent { body, .. } in &sent {
            let prompt = prompt_sent(body);
            assert!(
                prompt.len() <= MAX_PROMPT_BYTES,
                "prompt on the wire was {} bytes, over the {MAX_PROMPT_BYTES}-byte budget",
                prompt.len()
            );
            // ...and the budget is being spent, not collapsed to nothing -- a
            // bug that zeroed it would otherwise pass the bound above trivially.
            assert!(
                prompt.len() > MAX_PROMPT_BYTES / 2,
                "prompt on the wire was only {} bytes; the budget collapsed",
                prompt.len()
            );
        }
    }

    #[tokio::test]
    async fn the_prompt_on_the_wire_is_the_rendered_template_around_the_snippet() {
        // Pins the substitution itself: the snippet reaches Bedrock wrapped in
        // the template, exactly once, not raw and not doubled.
        let log = log_of(10, 0);
        let (client, replay) = replay_bedrock(vec![
            answers("<error_line>not in the log</error_line>"),
            answers("<error_line>not in the log</error_line>"),
        ]);

        let _ = refine_with_models(&client, &log, "THE-SNIPPET").await;

        let sent = replay.sent();
        assert_eq!(sent.len(), 2);
        // An independent oracle, not just `render_prompt` compared to itself:
        // a `render_prompt` that regressed to returning the snippet unchanged
        // would satisfy an `assert_eq!(prompt, render_prompt(..))` and every
        // placeholder check, so pin the surrounding template explicitly.
        let (before, after) = FIND_ERROR_LINE_PROMPT
            .split_once("{{LOG_SNIPPET}}")
            .expect("the template carries the placeholder");
        for Sent { body, .. } in &sent {
            let prompt = prompt_sent(body);
            assert_eq!(prompt, format!("{before}THE-SNIPPET{after}"));
            assert!(prompt.len() > "THE-SNIPPET".len());
            // Substituted exactly once -- `str::replace` would happily do it
            // twice if the template ever grew a second placeholder, and the
            // budget subtracts the template only once.
            assert_eq!(prompt.matches("THE-SNIPPET").count(), 1);
            assert!(!prompt.contains("{{LOG_SNIPPET}}"));
        }
    }

    #[tokio::test]
    async fn make_query_bounds_the_snippet_with_the_prompt_budget() {
        // `the_prompt_that_reaches_bedrock_stays_within_the_byte_budget` hands
        // `refine_with_models` a snippet the TEST bounded. This is the missing
        // half: that `make_query` -- which builds its own client, so it cannot
        // be driven over the replay transport -- applies that same bound itself.
        let log = log_of(2_000, 4_000); // ~8 MB, ~80x the budget
        let snippet = snippet_for_query(&log, &1_000, 500).expect("the anchor is in the log");

        assert!(render_prompt(&snippet).len() <= MAX_PROMPT_BYTES);
        assert!(snippet.len() > MAX_PROMPT_BYTES / 2, "the budget collapsed");
    }
}
