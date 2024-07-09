mod prompts;

use aws_config::meta::region::RegionProviderChain;
use aws_sdk_bedrockruntime::types::ConversationRole::User;
use aws_sdk_bedrockruntime::types::ContentBlock;
use aws_sdk_bedrockruntime::types::Message;
use prompts::FIND_ERROR_LINE_PROMPT;
use insta::assert_snapshot;
use aws_sdk_bedrockruntime::operation::converse::ConverseOutput;
use aws_sdk_bedrockruntime::operation::converse::ConverseError;
use aws_config::BehaviorVersion;
use aws_smithy_runtime_api;
use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_runtime_api::http::Response;
use tokio::fs;
// Creates a snippet of that is n lines long. The end of the snippet is the specified error line.
// Input: log_lines: Vec<&str>, error_line: &str, num_lines: usize
// Output: Vec<&str>
fn create_log_snippet<'a>(log_lines: Vec<&'a str>, error_line: &str, num_lines: usize) -> Vec<&'a str> {
    let mut snippet: Vec<&str> = Vec::new();
    
    // Find the index of the error line
    let error_line_index = log_lines.iter().position(|&line| line == error_line);
    
    // If error_line is not found, return an empty vector
    if let Some(error_index) = error_line_index {
        let start_index = error_index.saturating_sub(num_lines);
        let end_index = (error_index + num_lines + 1).min(log_lines.len());
        
        snippet.extend(&log_lines[start_index..end_index]);
    }
    
    snippet
}

async fn make_query(input_text: &String) -> Result<ConverseOutput, SdkError<ConverseError, Response>> {
    let region_provider = RegionProviderChain::default_provider().or_else("us-west-2");
    let config = aws_config::load_defaults(BehaviorVersion::v2024_03_28()).await;
    let client = aws_sdk_bedrockruntime::Client::new(&config);
    let prompt = FIND_ERROR_LINE_PROMPT.replace("{{LOG_SNIPPET}}", input_text);
    
    let content_block = ContentBlock::Text(prompt);
    
    let prompt_message = Message::builder()
        .content(content_block)
        .role(User)
        .build().unwrap();

    let model_id = "anthropic.claude-3-5-sonnet-20240620-v1:0"; // Replace with your model ID 


    let response = client.converse().model_id(model_id).messages(prompt_message).send().await?;
    
    Ok(response)
}

// add unit tests
#[cfg(test)]
mod test {
    fn test_create_log_snippet() {
        // Read the input log file
        let log_content = tokio::fs::read_to_string("fixtures/error_log1.txt");
        let log_lines: Vec<&str> = log_content.lines().collect();

        // Define the error line and number of lines for the snippet
        let error_line = "##[error]Process completed with exit code 1.";
        let num_lines = 100;

        // Call the function
        let result = create_log_snippet(log_lines, error_line, num_lines);

        // Convert result to a string
        let result_string = result.join("\n");

        // Assert against the snapshot
        assert_snapshot(result_string);

    }
}