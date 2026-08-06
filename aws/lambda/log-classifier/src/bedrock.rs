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
        Some(line) => line,
        None => return (0, None),
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

async fn query_model(log: &Log, input_text: &String, model_name: &String) -> Attempt {
    // A Bedrock failure must not take the whole invocation down with it:
    // `handle()` has already computed a ruleset verdict by this point and still
    // has to write it to DynamoDB, so anything that goes wrong here degrades to
    // "no LLM refinement" rather than panicking and discarding that verdict.
    let response = match make_bedrock_call(input_text, model_name).await {
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
    let model_id_primary = String::from("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    let model_id_secondary = String::from("us.anthropic.claude-sonnet-4-6");

    // Budget the rendered prompt, not just the snippet: the template is
    // substituted around the snippet before the call.
    let budget = MAX_PROMPT_BYTES.saturating_sub(FIND_ERROR_LINE_PROMPT.len());
    let input_text = snippet_around(log, *error_line, num_lines, budget)?;

    match query_model(log, &input_text, &model_id_primary).await {
        Attempt::Refined(r) => Some(r),
        Attempt::CallFailed => None,
        Attempt::Unusable => match query_model(log, &input_text, &model_id_secondary).await {
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

async fn make_bedrock_call(
    input_text: &String,
    model_id: &str,
) -> Result<ConverseOutput, SdkError<ConverseError, Response>> {
    let config = aws_config::load_defaults(BehaviorVersion::v2024_03_28()).await;
    let client = aws_sdk_bedrockruntime::Client::new(&config);
    let prompt = FIND_ERROR_LINE_PROMPT.replace("{{LOG_SNIPPET}}", input_text);

    let content_block = ContentBlock::Text(prompt);

    let prompt_message = Message::builder()
        .content(content_block)
        .role(User)
        .build()
        .unwrap();

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

    // // Actually use the llm. Uncomment and you should hopefully see a reasonable output.
    // #[tokio::test]
    // async fn test_make_query() {
    //     // Read the input log file
    //     let log_content = fs::read_to_string("fixtures/error_log1.txt")
    //         .expect("FIXTURES/error_log1.txt should exist!");
    //     let log = Log::new(log_content);
    //     // Define the error line and number of lines for the snippet
    //     let error_line = 4047;
    //     let num_lines = 200;

    //     // Call the make_query function
    //     let query_result = make_query(&log, &error_line, num_lines).await;
    //     panic!("The query result is | {:#?}", query_result.unwrap());
    // }
}
