import styled from "@emotion/styled";
import { useState, useEffect, useRef, useMemo } from "react";
import { Typography, Paper, TextField, Button, Box, useTheme, Collapse, IconButton } from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import AISpinner from "./AISpinner";

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
  position: "relative",
  backgroundColor: theme.palette.mode === "dark" ? "#1a1a1a" : "#f5f5f5",
  scrollBehavior: "smooth", // Add smooth scrolling
}));

// Use theme-aware styling for the response text
const ResponseText = styled("pre")(({ theme }) => ({
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "monospace",
  margin: 0,
  lineHeight: 1.5,
  paddingTop: "1em",
  color: theme.palette.mode === "dark" ? "#e0e0e0" : "inherit",
}));

// Tool use block styling
const ToolUseBlock = styled(Paper)(({ theme }) => ({
  padding: "12px",
  marginTop: "10px",
  marginBottom: "10px",
  backgroundColor: theme.palette.mode === "dark" ? "#2d3748" : "#e6f7ff",
  borderLeft: `4px solid ${theme.palette.mode === "dark" ? "#63b3ed" : "#1890ff"}`,
  overflow: "hidden",
  transition: "max-height 0.3s ease-in-out"
}));

const ToolName = styled(Typography)(({ theme }) => ({
  fontWeight: "bold",
  marginBottom: "8px",
  color: theme.palette.mode === "dark" ? "#90cdf4" : "#0050b3",
}));

const ToolInput = styled("pre")(({ theme }) => ({
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "monospace",
  margin: 0,
  fontSize: "0.9em",
  padding: "8px",
  backgroundColor: theme.palette.mode === "dark" ? "#1a202c" : "#f0f7ff",
  borderRadius: "4px",
  color: theme.palette.mode === "dark" ? "#e2e8f0" : "#333",
}));

const LoaderWrapper = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "15px",
  marginTop: "20px",
  marginBottom: "20px",
  backgroundColor: theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.03)",
  borderRadius: "12px",
  boxShadow: theme.palette.mode === "dark" ? "0 4px 12px rgba(0, 0, 0, 0.2)" : "0 4px 12px rgba(0, 0, 0, 0.05)",
  border: `1px solid ${theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.05)"}`,
  transition: "all 0.3s ease-in-out"
}));

const GrafanaChartContainer = styled(Box)(({ theme }) => ({
  marginTop: "15px",
  marginBottom: "15px",
  borderRadius: "4px",
  border: `1px solid ${theme.palette.divider}`,
  overflow: "hidden",
}));

const ChartHeader = styled(Box)(({ theme }) => ({
  padding: "10px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  borderBottom: `1px solid ${theme.palette.divider}`,
  backgroundColor: theme.palette.mode === "dark" ? "#1f1f1f" : "#f5f5f5",
}));

// Component for embedding Grafana charts
const GrafanaEmbed = ({ dashboardId }: { dashboardId: string }) => {
  const { themeMode, darkMode } = useDarkMode();
  
  // Set theme parameter based on dark mode context
  let chartTheme = "light";
  if (themeMode === "system") {
    chartTheme = darkMode ? "dark" : "light";
  } else {
    chartTheme = themeMode;
  }
  
  // Replace the host with our proxy
  // This assumes your API proxy setup is consistent with other dashboard embeds
  const dashboardUrl = `https://disz2yd9jqnwc.cloudfront.net/public-dashboards/${dashboardId}?theme=${chartTheme}`;
  
  return (
    <GrafanaChartContainer>
      <ChartHeader>
        <Typography variant="subtitle2">Grafana Dashboard</Typography>
        <Button 
          href={`https://pytorchci.grafana.net/public-dashboards/${dashboardId}`} 
          target="_blank"
          size="small"
          variant="outlined"
        >
          Open in Grafana
        </Button>
      </ChartHeader>
      <Box sx={{ height: "640px", width: "100%" }}>
        <iframe
          src={dashboardUrl}
          width="100%"
          height="100%"
          frameBorder="0"
          title={`Grafana Dashboard ${dashboardId}`}
        />
      </Box>
    </GrafanaChartContainer>
  );
};

// Define interfaces for response types
interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: any;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
}

interface AssistantMessage {
  id: string;
  type: string;
  role: string;
  content: (ContentBlock | ToolUse)[];
  stop_reason?: string;
  model?: string;
}

interface MessageWrapper {
  type: string;
  message?: AssistantMessage;
  delta?: {
    type: string;
    text?: string;
  };
  error?: string;
}

interface GrafanaLink {
  fullUrl: string;
  dashboardId: string;
}

// Type to represent different types of parsed content
type ParsedContent = {
  type: "text" | "tool_use";
  content: string;
  toolName?: string;
  toolInput?: any;
  grafanaLinks?: GrafanaLink[];
};

// Import the DarkMode context
import { useDarkMode } from "../lib/DarkModeContext";

// Function to extract Grafana dashboard links from text
const extractGrafanaLinks = (text: string): GrafanaLink[] => {
  // Regular expression to match Grafana dashboard links
  // This pattern matches links like https://pytorchci.grafana.net//public-dashboards/d0739d05d0544b88b9aea8a785b409d2
  // It extracts the dashboard ID
  const grafanaLinkRegex = /https?:\/\/pytorchci\.grafana\.net\/?\/?public-dashboards\/([a-zA-Z0-9]+)/g;
  
  const links: GrafanaLink[] = [];
  let match;
  
  while ((match = grafanaLinkRegex.exec(text)) !== null) {
    links.push({
      fullUrl: match[0],
      dashboardId: match[1]
    });
  }
  
  return links;
};

// Function to make text with Grafana links clickable
const renderTextWithLinks = (text: string): React.ReactNode => {
  if (!text) return null;
  
  // Create a React element array to build the result
  const result: React.ReactNode[] = [];
  
  // Regular expression to match Grafana dashboard links
  // Using capture groups to extract just the URL
  const grafanaLinkRegex = /(https?:\/\/pytorchci\.grafana\.net\/?\/?public-dashboards\/[a-zA-Z0-9]+)/g;
  
  let lastIndex = 0;
  let match;
  let counter = 0;
  
  // Find all matches and build the result array
  while ((match = grafanaLinkRegex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      result.push(text.substring(lastIndex, match.index));
    }
    
    // Add the link
    result.push(
      <a 
        key={counter++}
        href={match[1]} 
        target="_blank" 
        rel="noopener noreferrer"
        style={{ color: '#1976d2', textDecoration: 'underline' }}
      >
        {match[1]}
      </a>
    );
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    result.push(text.substring(lastIndex));
  }
  
  return result;
};

export const McpQueryPage = () => {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState("");
  const [parsedResponses, setParsedResponses] = useState<ParsedContent[]>([]);
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0);
  
  // Funny thinking messages
  const thinkingMessages = useMemo(() => [
    "Crunching numbers...",
    "Working hard...",
    "Quantum tunneling...",
    "Consulting the oracle...",
    "Training neurons...",
    "Brewing dashboard magic...",
    "Mining insights...",
    "Recalibrating flux capacitor...",
    "Untangling spaghetti code...",
    "Summoning visualization wizards...",
    "Defragmenting brain cells...",
    "Polishing pixels...",
    "Warming up GPUs..."
  ], []);
  
  // Rotate through thinking messages every 3 seconds
  useEffect(() => {
    if (!isLoading) return;
    
    const interval = setInterval(() => {
      setThinkingMessageIndex(prev => (prev + 1) % thinkingMessages.length);
    }, 3000);
    
    return () => clearInterval(interval);
  }, [isLoading, thinkingMessages.length]);
  const [error, setError] = useState("");
  const [debugVisible, setDebugVisible] = useState(false);
  
  // Reference to the active fetch controller
  const fetchControllerRef = useRef<AbortController | null>(null);
  
  // Reference to the results container for auto-scrolling
  const resultsContainerRef = useRef<HTMLDivElement>(null);
  
  // Function to scroll to bottom of results
  const scrollToBottom = () => {
    if (resultsContainerRef.current) {
      const scrollHeight = resultsContainerRef.current.scrollHeight;
      const height = resultsContainerRef.current.clientHeight;
      const maxScrollTop = scrollHeight - height;
      resultsContainerRef.current.scrollTop = maxScrollTop > 0 ? maxScrollTop : 0;
    }
  };

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  // Parse response JSON and extract content  
  const parseJsonLine = (line: string) => {
    try {
      if (!line.trim()) return;
      
      // For debug display
      setResponse(prev => prev + line + "\n");
      
      // Parse the JSON
      const json = JSON.parse(line) as MessageWrapper;
      
      // Handle different response types
      if (json.type === "assistant" && json.message?.content) {
        // Process each content block
        json.message.content.forEach(item => {
          if (item.type === "text" && 'text' in item) {
            // Handle text content
            const textContent = item.text || "";
            const grafanaLinks = extractGrafanaLinks(textContent);
            
            setParsedResponses(prev => {
              const newResponses = [
                ...prev, 
                { 
                  type: "text", 
                  content: textContent, 
                  grafanaLinks: grafanaLinks.length > 0 ? grafanaLinks : undefined
                }
              ];
              // Schedule a scroll after the state update
              setTimeout(scrollToBottom, 0);
              return newResponses;
            });
          } 
          else if (item.type === "tool_use" && 'name' in item && 'input' in item) {
            // Handle tool use content
            setParsedResponses(prev => {
              const newResponses = [
                ...prev, 
                { 
                  type: "tool_use", 
                  content: "", 
                  toolName: item.name,
                  toolInput: item.input
                }
              ];
              // Schedule a scroll after the state update
              setTimeout(scrollToBottom, 0);
              return newResponses;
            });
          }
        });
      } 
      else if (json.type === "content_block_delta") {
        if (json.delta?.type === "text" && json.delta.text) {
          setParsedResponses(prev => {
            let updated;
            
            if (prev.length > 0 && prev[prev.length - 1].type === "text") {
              updated = [...prev];
              updated[updated.length - 1].content += json.delta.text;
              
              // Re-extract Grafana links from the updated content
              const fullContent = updated[updated.length - 1].content;
              updated[updated.length - 1].grafanaLinks = extractGrafanaLinks(fullContent);
            } else {
              const textContent = json.delta.text;
              updated = [
                ...prev, 
                { 
                  type: "text", 
                  content: textContent,
                  grafanaLinks: extractGrafanaLinks(textContent)
                }
              ];
            }
            
            // Schedule a scroll after the state update
            setTimeout(scrollToBottom, 0);
            return updated;
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
  
  // Auto-scroll to bottom when new responses are added or loading state changes
  useEffect(() => {
    // Use multiple timeouts to ensure scrolling works
    // First immediate scroll
    scrollToBottom();
    
    // Then after a short delay to allow DOM updates
    const timer1 = setTimeout(scrollToBottom, 50);
    
    // And again after a longer delay for any async content
    const timer2 = setTimeout(scrollToBottom, 150);
    
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
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
    setParsedResponses([]); // Reset to empty array of ParsedContent
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
        PyTorch Grafana Agent
      </Typography>
      <Typography variant="body1" paragraph>
        What timeseries should we create for you?
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
        
        {parsedResponses.length > 0 ? (
          <div>
            {parsedResponses.map((item, index) => (
              <div key={index}>
                {item.type === "text" ? (
                  <>
                    <ResponseText>
                      {renderTextWithLinks(item.content?.trim() || "")}
                    </ResponseText>
                    
                    {/* Render Grafana embeds if links are present */}
                    {item.grafanaLinks && item.grafanaLinks.length > 0 && (
                      <Box mt={2}>
                        {item.grafanaLinks.map((link, i) => (
                          <GrafanaEmbed key={i} dashboardId={link.dashboardId} />
                        ))}
                      </Box>
                    )}
                  </>
                ) : item.type === "tool_use" && item.toolName ? (
                  <ToolUseBlock>
                    <Box display="flex" justifyContent="space-between" alignItems="center">
                      <ToolName variant="subtitle2">
                        🛠️ Tool: {item.toolName}
                      </ToolName>
                      <IconButton 
                        onClick={() => setExpandedTools(prev => ({
                          ...prev, 
                          [index]: !prev[index]
                        }))}
                        size="small"
                      >
                        {expandedTools[index] ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
                      </IconButton>
                    </Box>
                    <Collapse in={expandedTools[index]} timeout="auto">
                      <ToolInput>
                        {JSON.stringify(item.toolInput, null, 2)}
                      </ToolInput>
                    </Collapse>
                  </ToolUseBlock>
                ) : null}
                {index < parsedResponses.length - 1 && item.type === "text" && parsedResponses[index + 1].type === "text" && <hr />}
              </div>
            ))}
            
            {/* Add thinking indicator at the bottom if still loading */}
            {isLoading && (
              <LoaderWrapper>
                <AISpinner />
                <Typography variant="body2" sx={{ ml: 2 }}>
                  {thinkingMessages[thinkingMessageIndex]}
                </Typography>
              </LoaderWrapper>
            )}
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
        
        {/* Show loading indicator for empty results case */}
        {isLoading && parsedResponses.length === 0 && (
          <LoaderWrapper>
            <AISpinner />
            <Typography variant="body2" sx={{ ml: 2 }}>
              {thinkingMessages[thinkingMessageIndex]}
            </Typography>
          </LoaderWrapper>
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