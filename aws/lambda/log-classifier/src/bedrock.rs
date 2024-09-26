mod prompts;

use crate::engine::get_snippets;
use crate::log::Log;
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
fn validate_output_in_log(ai_output: &str, log: &Log) -> Option<String> {
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
        None => return None,
    };

    // Search for the extracted error line in the log
    for (_, log_entry) in log.lines.iter() {
        if log_entry == &error_line {
            return Some(log_entry.to_string());
        }
    }

    // If no matching line is found in the log, return None
    None
}

/// Makes a query to an AI model using the provided prompt.
///
/// This function sends the prompt to two different AI models and validates the output.
/// If a valid response is found, it is returned.
///
/// # Arguments
///
/// * `log` - A reference to the Log structure containing the full log
/// * `prompt` - The prompt to send to the AI models
///
/// # Returns
///
/// An Option<String> containing the validated AI response, or None if no valid response was found.
pub async fn make_query(log: &Log, prompt: &str) -> Option<String> {
    let model_id_primary = "anthropic.claude-3-haiku-20240307-v1:0";
    let model_id_secondary = "anthropic.claude-3-5-sonnet-20240620-v1:0";

    // Try the primary model
    let response = make_bedrock_call(prompt, model_id_primary).await;
    let validation = validate_output_in_log(
        &response
            .unwrap()
            .output
            .unwrap()
            .as_message()
            .unwrap()
            .content[0]
            .as_text()
            .unwrap()
            .clone(),
        &log,
    );
    if validation.is_some() {
        return Some(validation.unwrap());
    }

    // If primary model fails, try the secondary model
    let response = make_bedrock_call(prompt, model_id_secondary).await;
    let validation = validate_output_in_log(
        &response
            .unwrap()
            .output
            .unwrap()
            .as_message()
            .unwrap()
            .content[0]
            .as_text()
            .unwrap()
            .clone(),
        &log,
    );
    if validation.is_some() {
        return Some(validation.unwrap());
    }

    None
}

async fn make_bedrock_call(
    prompt: &str,
    model_id: &str,
) -> Result<ConverseOutput, SdkError<ConverseError, Response>> {
    let config = aws_config::load_defaults(BehaviorVersion::v2024_03_28()).await;
    let client = aws_sdk_bedrockruntime::Client::new(&config);

    let content_block = ContentBlock::Text(prompt.to_string());

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

// rewri

fn generate_prompt_error_line(log: &Log, error_line: &str, num_lines: usize) -> Option<String> {
    let log_snippet = get_snippets(log, line_numbers, num_lines / 2, num_lines + 1);

    // ensure length is 1 of the log_snippet
    if log_snippet.len() != 1 {
        return None;
    }

    let input_text = log_snippet.first().unwrap();
    let prompt = FIND_ERROR_LINE.replace("{{LOG_SNIPPET}}", input_text);
    Some(prompt)

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
        let error_line = "<error_line>##[error]Process completed with exit code 1.</error_line>";
        let validation_result = validate_output_in_log(error_line, &log);
        // Assert is error_line
        assert_eq!(
            validation_result,
            Some("##[error]Process completed with exit code 1.".to_string())
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
        let validation_log_too_long = validate_output_in_log(error_line_too_long, &log);
        // Assert is validation_log_too_long is None
        assert_eq!(validation_log_too_long, None);
        let validation_log_too_short = validate_output_in_log(error_line2_too_short, &log);
        // Assert is validation_log_too_short is None
        assert_eq!(validation_log_too_short, None);
        let validation_log_no_tag = validate_output_in_log(error_line_no_tag, &log);
        // Assert is validation_log_no_tag is None
        assert_eq!(validation_log_no_tag, None);
        let validation_log_partial_tag1 = validate_output_in_log(error_line_partial_tag1, &log);
        // Assert is validation_log_partial_tag1 is None
        assert_eq!(validation_log_partial_tag1, None);
        let validation_log_partial_tag2 = validate_output_in_log(error_line_partial_tag2, &log);
        // Assert is validation_log_partial_tag2 is None
        assert_eq!(validation_log_partial_tag2, None);
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
