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

fn validate_output_in_log(input: &str, original_string: &String) -> Option<String> {
    // Try to extract content between <error_line> tags
    let start_tag = "<error_line>";
    let end_tag = "</error_line>";

    let mut output = None;

    input.find(start_tag).and_then(|start_index| {
        input[start_index + start_tag.len()..]
            .find(end_tag)
            .map(|end_index| {
                let content = &input
                    [start_index + start_tag.len()..start_index + start_tag.len() + end_index];

                // Trim both leading and trailing whitespace and newlines
                content.trim().to_string();
                output = Some(content);
            })
    });

    // If the content is not found, return None
    if output.is_none() {
        return None;
    }

    // seperate original_string into lines seperated by newline
    let original_lines: Vec<&str> = original_string.split("\n").collect();
    // Check if the output is a valid line in the original string
    if original_lines.contains(&output.unwrap()) {
        return Some(output.unwrap().to_string());
    }
    return None;
}

// Creates a snippet of that is n lines long. The end of the snippet is the specified error line. If the error line is not found an empty Vec is returned.
// Input: log: Log, error_line: &str, num_lines: usize
// Output: Vec<&str>
pub fn create_log_snippet<'a>(log: Log, error_line: &str, num_lines: usize) -> Vec<String> {
    let mut snippet: Vec<String> = Vec::new();
    let mut found_error_line = false;
    // Find the index of the error line. We only care that the line contains the error message.
    for (_, line) in log.lines.iter().enumerate() {
        let (_, line_content) = line;
        snippet.push(line_content.to_string());
        if line_content.contains(error_line) {
            found_error_line = true;
            break;
        }
    }

    // If the error line is not found, return nothing
    if !found_error_line {
        return Vec::new();
    }

    // if snippet is too larget shrink it to the size of num_lines by cutting off the beginning
    if snippet.len() > num_lines {
        snippet = snippet.split_at(snippet.len() - num_lines).1.to_vec();
    }

    snippet
}
pub async fn make_query(input_text: &String) -> Option<String> {
    let model_id_primary = "anthropic.claude-3-haiku-20240307-v1:0";
    let model_id_secondary = "anthropic.claude-3-5-sonnet-20240620-v1:0";

    let response = make_bedrock_call(input_text, model_id_primary).await;

    // validate the response
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
        input_text,
    );
    if validation.is_some() {
        return Some(validation.unwrap());
    }

    let response = make_bedrock_call(input_text, model_id_secondary).await;
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
        input_text,
    );
    if validation.is_some() {
        return Some(validation.unwrap());
    }
    return None;
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
