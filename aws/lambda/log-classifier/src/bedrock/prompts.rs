// LOG_SNIPPET a part of an error log
pub const FIND_ERROR_LINE_PROMPT: &str = r#"
You are an AI assistant tasked with identifying the most likely actionable error in a log snippet. Your goal is to find and report the single line that best indicates the error occurring in the system.

Here is the log snippet you need to analyze:

<log_snippet>
{{LOG_SNIPPET}}
</log_snippet>

To complete this task, follow these steps:

1. Carefully read through the entire log snippet.
2. Look for lines that indicate errors, exceptions, failures, or unexpected behavior. Pay special attention to:
   - Error messages
   - Exception traces
   - Warning messages
   - Unexpected state changes
   - Timeouts or performance issues
3. If multiple error indicators are present, prioritize the one that seems most critical or is likely the root cause of other issues.
4. Select the single line that best represents the actionable error occurring in the system.

Once you have identified the most indicative error line, provide your response in the following format:

<error_line>
[Insert the exact line from the log that best indicates the error, copied verbatim]
</error_line>

Important notes:
- Do not modify or paraphrase the log line in any way.
- Include only one line in your response, even if multiple lines seem relevant.
- If you cannot find any line indicating an error, respond with:
<error_line>No clear error found in the provided log snippet.</error_line>

Provide only the <error_line> tags and their content in your response, without any additional explanation or commentary.
"#;