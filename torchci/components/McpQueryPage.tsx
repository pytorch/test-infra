import styled from "@emotion/styled";
import { useState, useEffect, useRef } from "react";
import { Typography, Paper, TextField, Button, Box, CircularProgress } from "@mui/material";

const McpQueryPageContainer = styled("div")({
  fontFamily: "Roboto",
  padding: "20px",
  maxWidth: "1200px",
  margin: "0 auto",
});

const QuerySection = styled(Paper)({
  padding: "20px",
  marginBottom: "20px",
});

const ResultsSection = styled(Paper)({
  padding: "20px",
  minHeight: "300px",
  maxHeight: "600px",
  overflowY: "auto",
  position: "relative",
  backgroundColor: "#f5f5f5",
});

const ResponseText = styled("pre")({
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "monospace",
  margin: 0,
  lineHeight: 1.5,
});

const LoaderWrapper = styled("div")({
  position: "absolute",
  top: "10px",
  right: "10px",
});

// Define TypeScript interfaces for the response structure
interface TextContent {
  type: string;
  text: string;
}

interface ToolUseContent {
  type: string;
  id: string;
  name: string;
  input: any;
}

type MessageContent = TextContent | ToolUseContent;
export const McpQueryPage = () => {
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState("");
  const [parsedResponses, setParsedResponses] = useState<string[]>([]);
  const [error, setError] = useState("");
  
  // Reference to the results container for auto-scrolling
  const resultsContainerRef = useRef<HTMLDivElement>(null);

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };
  
  // Parse response JSON and extract text content
  const parseResponse = (jsonString: string) => {
    try {
      const parsedData = JSON.parse(jsonString);
      
      // Only process assistant messages with text content
      if (parsedData.type === "assistant" && parsedData.message && parsedData.message.content) {
        // Extract text content from the assistant message
        const textContents = parsedData.message.content
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text);
        
        if (textContents.length > 0) {
          setParsedResponses(prev => [...prev, ...textContents]);
        }
      }
    } catch (err) {
      // Silently ignore parsing errors for non-JSON chunks or incomplete JSON
      console.log("Failed to parse JSON chunk:", err);
    }
  };
  
  // Auto-scroll to bottom when new content is added
  useEffect(() => {
    if (resultsContainerRef.current && isLoading) {
      resultsContainerRef.current.scrollTop = resultsContainerRef.current.scrollHeight;
    }
  }, [parsedResponses, isLoading]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    
    if (!query.trim()) {
      setError("Query cannot be empty");
      return;
    }

    setIsLoading(true);
    setResponse("");
    setParsedResponses([]);
    setError("");

    try {
      const response = await fetch('/api/grafana_mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'An error occurred while processing your query');
      }

      // Handle streaming response
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Unable to read response stream');
      }

      // Process the stream
      const decoder = new TextDecoder();
      let buffer = ""; // Buffer to accumulate partial JSON chunks
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          setIsLoading(false);
          break;
        }
        
        // Decode the chunk
        const chunk = decoder.decode(value, { stream: true });

        console.log('chunk', chunk)
        
        // Store raw response for debugging
        setResponse((prevResponse) => prevResponse + chunk);
        
        // Try to process complete JSON objects
        buffer += chunk;
        
        // Split by newlines or other delimiters if present
        const lines = buffer.split(/\n|\r\n/);
        
        // Process all complete lines except the last one (which might be incomplete)
        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].trim()) {
            parseResponse(lines[i]);
          }
        }
        
        // Keep the potentially incomplete last line in the buffer
        buffer = lines[lines.length - 1];
      }
      
      // Process any remaining content in the buffer
      if (buffer.trim()) {
        parseResponse(buffer);
      }
    } catch (err) {
      setError(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setIsLoading(false);
    }
  };

  return (
    <McpQueryPageContainer>
      <Typography variant="h4" gutterBottom>
        MCP Query Interface
      </Typography>
      <Typography variant="body1" paragraph>
        Enter your MCP query below and click RUN to execute it.
      </Typography>

      <QuerySection>
        <Box component="form" onSubmit={handleSubmit} noValidate>
          <TextField
            fullWidth
            label="Enter your query"
            value={query}
            onChange={handleQueryChange}
            margin="normal"
            multiline
            rows={3}
            placeholder="Enter your MCP query here..."
            variant="outlined"
            disabled={isLoading}
          />
          <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 2 }}>
            <Button
              variant="contained"
              color="primary"
              type="submit"
              disabled={isLoading}
            >
              {isLoading ? "Running..." : "RUN"}
            </Button>
          </Box>
        </Box>
      </QuerySection>

      <ResultsSection ref={resultsContainerRef}>
        <Typography variant="h6" gutterBottom>
          Results
        </Typography>
        {error && (
          <Typography color="error" paragraph>
            {error}
          </Typography>
        )}
        {isLoading && (
          <LoaderWrapper>
            <CircularProgress size={24} />
          </LoaderWrapper>
        )}
        
        {parsedResponses.length > 0 ? (
          <div>
            {parsedResponses.map((text, index) => (
              <ResponseText key={index}>
                {text}
                {index < parsedResponses.length - 1 && <hr />}
              </ResponseText>
            ))}
          </div>
        ) : (
          !isLoading && !error && (
            <Typography color="textSecondary" align="center" sx={{ mt: 5 }}>
              Run a query to see results here.
            </Typography>
          )
        )}
        
        {/* Debug toggle to see raw response if needed */}
        {/*
        <details style={{ marginTop: '20px', borderTop: '1px solid #ccc', paddingTop: '10px' }}>
          <summary>Debug: Raw Response</summary>
          <pre style={{ fontSize: '0.8em', opacity: 0.7 }}>{response}</pre>
        </details>
        */}
      </ResultsSection>
    </McpQueryPageContainer>
  );
};