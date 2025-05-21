import styled from "@emotion/styled";
import { useState, useEffect, useRef } from "react";
import { Typography, Paper, TextField, Button, Box, CircularProgress, useTheme } from "@mui/material";

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

// Use theme-aware styling for the results section
const ResultsSection = styled(Paper)(({ theme }) => ({
  padding: "20px",
  minHeight: "300px",
  maxHeight: "600px",
  overflowY: "auto",
  position: "relative",
  backgroundColor: theme.palette.mode === "dark" ? "#1a1a1a" : "#f5f5f5",
}));

// Use theme-aware styling for the response text
const ResponseText = styled("pre")(({ theme }) => ({
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "monospace",
  margin: 0,
  lineHeight: 1.5,
  color: theme.palette.mode === "dark" ? "#e0e0e0" : "inherit",
}));

const LoaderWrapper = styled("div")({
  position: "absolute",
  top: "10px",
  right: "10px",
});

export const McpQueryPage = () => {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState("");
  const [parsedResponses, setParsedResponses] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [debugVisible, setDebugVisible] = useState(false);
  
  // Reference to the active fetch controller
  const fetchControllerRef = useRef<AbortController | null>(null);
  
  // Reference to the results container for auto-scrolling
  const resultsContainerRef = useRef<HTMLDivElement>(null);

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  // Parse response JSON and extract text content  
  const parseJsonLine = (line: string) => {
    try {
      if (!line.trim()) return;
      
      // For debug display
      setResponse(prev => prev + line + "\n");
      
      // Parse the JSON
      const json = JSON.parse(line);
      
      // Handle different response types
      if (json.type === "assistant" && json.message?.content) {
        const texts = json.message.content
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text);
        
        if (texts.length > 0) {
          setParsedResponses(prev => [...prev, ...texts]);
        }
      } 
      else if (json.type === "content_block_delta") {
        if (json.delta?.type === "text" && json.delta.text) {
          setParsedResponses(prev => {
            if (prev.length > 0) {
              const updated = [...prev];
              updated[updated.length - 1] += json.delta.text;
              return updated;
            } else {
              return [json.delta.text];
            }
          });
        }
      }
      else if (json.error) {
        setError(`Error: ${json.error}`);
      }
    } catch (err) {
      // Ignore parsing errors for partial chunks
      console.log("Failed to parse:", line);
    }
  };
  
  // Cancel ongoing request
  const cancelRequest = () => {
    if (fetchControllerRef.current) {
      fetchControllerRef.current.abort();
      fetchControllerRef.current = null;
      setIsLoading(false);
    }
  };
  
  // Auto-scroll to bottom when new responses are added
  useEffect(() => {
    if (resultsContainerRef.current && isLoading) {
      resultsContainerRef.current.scrollTop = resultsContainerRef.current.scrollHeight;
    }
  }, [parsedResponses, isLoading]);
  
  // Clean up on component unmount
  useEffect(() => {
    return () => {
      cancelRequest();
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    
    if (!query.trim()) {
      setError("Query cannot be empty");
      return;
    }

    // Cancel any ongoing request
    cancelRequest();
    
    // Reset state
    setIsLoading(true);
    setResponse("");
    setParsedResponses([]);
    setError("");

    // Create a new AbortController
    fetchControllerRef.current = new AbortController();
    
    // Enable streaming directly
    try {
      // Use the Fetch API with appropriate settings
      const response = await fetch('/api/grafana_mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ query }),
        signal: fetchControllerRef.current.signal,
        // These are critical for proper streaming
        cache: 'no-store',
        // @ts-ignore - This is not in the type defs but is supported
        duplex: 'half',
      });

      // Handle non-ok responses
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `HTTP error: ${response.status}`);
      }

      // Get the body stream
      if (!response.body) {
        throw new Error("Response body is null");
      }

      // Create a reader for the stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      
      // Process the stream
      while (true) {
        // Break if request was aborted
        if (fetchControllerRef.current === null) break;
        
        const { done, value } = await reader.read();
        
        if (done) {
          // Process any incomplete buffer content
          if (buffer.trim()) {
            parseJsonLine(buffer.trim());
          }
          setIsLoading(false);
          break;
        }
        
        // Convert bytes to text
        const text = decoder.decode(value, { stream: true });
        
        // Add to buffer
        buffer += text;
        
        // Process complete lines
        const lines = buffer.split('\n');
        
        // Process all complete lines
        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].trim()) {
            parseJsonLine(lines[i].trim());
          }
        }
        
        // Keep last potentially incomplete line in buffer
        buffer = lines[lines.length - 1];
      }
      
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('Request cancelled');
      } else {
        console.error('Fetch error:', err);
        setError(`Error: ${err.message}`);
      }
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
          <Box sx={{ display: "flex", justifyContent: "space-between", mt: 2 }}>
            <Button 
              variant="outlined"
              color="secondary"
              onClick={() => setDebugVisible(!debugVisible)}
            >
              {debugVisible ? "Hide Debug" : "Show Debug"}
            </Button>
            <Box>
              {isLoading && (
                <Button
                  variant="outlined"
                  color="error"
                  onClick={cancelRequest}
                  sx={{ mr: 1 }}
                >
                  Cancel
                </Button>
              )}
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
            <Typography 
              color="textSecondary" 
              align="center" 
              sx={{ mt: 5 }}
            >
              Run a query to see results here.
            </Typography>
          )
        )}
        
        {/* Debug section with raw response */}
        {debugVisible && (
          <Box 
            sx={{ 
              marginTop: '20px', 
              borderTop: `1px solid ${theme.palette.divider}`, 
              paddingTop: '10px' 
            }}
          >
            <Typography variant="subtitle2">Debug: Raw Response</Typography>
            <pre 
              style={{ 
                fontSize: '0.8em',
                opacity: 0.7, 
                maxHeight: '200px', 
                overflowY: 'auto',
                backgroundColor: theme.palette.mode === "dark" ? "#121212" : "#f0f0f0",
                padding: '8px',
                borderRadius: '4px',
                color: theme.palette.mode === "dark" ? "#e0e0e0" : "#333333"
              }}
            >
              {response || "(No data yet)"}
            </pre>
          </Box>
        )}
      </ResultsSection>
    </McpQueryPageContainer>
  );
};