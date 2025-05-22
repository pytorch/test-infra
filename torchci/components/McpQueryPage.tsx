import styled from "@emotion/styled";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  Box,
  Button,
  Collapse,
  IconButton,
  Paper,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import AISpinner from "./AISpinner";
import ToolIcon from "./ToolIcon";

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
  borderLeft: `4px solid ${
    theme.palette.mode === "dark" ? "#63b3ed" : "#1890ff"
  }`,
  overflow: "hidden",
  transition: "max-height 0.3s ease-in-out",
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

const ChunkMetadata = styled(Typography)(({ theme }) => ({
  fontSize: "0.75em",
  color: theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.5)",
  textAlign: "right",
  marginTop: "4px",
  marginBottom: "16px",
  fontFamily: "monospace",
}));

const LoaderWrapper = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px 25px", // More horizontal padding for the wider spinner
  marginTop: "20px",
  marginBottom: "20px",
  backgroundColor:
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.05)"
      : "rgba(0, 0, 0, 0.03)",
  borderRadius: "16px", // Larger radius
  boxShadow:
    theme.palette.mode === "dark"
      ? "0 4px 12px rgba(0, 0, 0, 0.2)"
      : "0 4px 12px rgba(0, 0, 0, 0.05)",
  border: `1px solid ${
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.1)"
      : "rgba(0, 0, 0, 0.05)"
  }`,
  transition: "all 0.3s ease-in-out",
  overflow: "visible", // Allow sparkles to overflow
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
  usage?: {
    output_tokens: number;
    input_tokens?: number;
  };
}

interface GrafanaLink {
  fullUrl: string;
  dashboardId: string;
}

// Type to represent different types of parsed content
type ParsedContent = {
  type: "text" | "tool_use";
  content: string;
  displayedContent?: string; // For typewriter effect
  toolName?: string;
  toolInput?: any;
  grafanaLinks?: GrafanaLink[];
  isAnimating?: boolean; // Track if this content is still animating
  timestamp?: number; // When this content was received
  outputTokens?: number; // Number of output tokens used
};

// Import the DarkMode context
import { useDarkMode } from "../lib/DarkModeContext";

// Function to extract Grafana dashboard links from text
const extractGrafanaLinks = (text: string): GrafanaLink[] => {
  // Regular expression to match Grafana dashboard links
  // This pattern matches links like https://pytorchci.grafana.net//public-dashboards/d0739d05d0544b88b9aea8a785b409d2
  // It extracts the dashboard ID
  const grafanaLinkRegex =
    /https?:\/\/pytorchci\.grafana\.net\/?\/?public-dashboards\/([a-zA-Z0-9]+)/g;

  const links: GrafanaLink[] = [];
  let match;

  while ((match = grafanaLinkRegex.exec(text)) !== null) {
    links.push({
      fullUrl: match[0],
      dashboardId: match[1],
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
  const grafanaLinkRegex =
    /(https?:\/\/pytorchci\.grafana\.net\/?\/?public-dashboards\/[a-zA-Z0-9]+)/g;

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
        style={{ color: "#1976d2", textDecoration: "underline" }}
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

  // Add blinking cursor at the end for text that's still typing
  if (text.length > 0 && result.length > 0) {
    // Get the last item in the array
    const lastItem = result[result.length - 1];

    // If it's a string, we can add the cursor (can't append to React components)
    if (typeof lastItem === "string") {
      // Replace the last item with the text + cursor
      result[result.length - 1] = (
        <>
          {lastItem}
          <span
            className="blinking-cursor"
            style={{
              borderRight: "2px solid currentColor",
              marginLeft: "2px",
              animation: "blink 1s step-end infinite",
            }}
          ></span>
          <style jsx>{`
            @keyframes blink {
              0%,
              100% {
                opacity: 1;
              }
              50% {
                opacity: 0;
              }
            }
          `}</style>
        </>
      );
    }
  }

  return result;
};

// Format seconds to mm:ss or hh:mm:ss
const formatElapsedTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
};

export const McpQueryPage = () => {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState("");
  const [parsedResponses, setParsedResponses] = useState<ParsedContent[]>([]);
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>(
    {}
  );
  const [typingSpeed] = useState(10); // ms per character for typewriter effect
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0); // in seconds

  // Funny thinking messages
  const thinkingMessages = useMemo(
    () => [
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
      "Warming up GPUs...",
      "Convincing metrics to behave...",
      "Interrogating databases...",
      "Reticulating splines...",
      "Calibrating the metric-o-meter...",
      "Wrangling unruly data points...",
      "Converting caffeine to dashboards...",
      "Bending time series to my will...",
      "Calculating the meaning of metrics...",
      "Hacking the mainframe...",
      "Negotiating with stubborn algorithms...",
    ],
    []
  );

  // Rotate through thinking messages every 6 seconds
  useEffect(() => {
    if (!isLoading) return;

    const interval = setInterval(() => {
      setThinkingMessageIndex((prev) => (prev + 1) % thinkingMessages.length);
    }, 6000); // Doubled to 6 seconds

    return () => clearInterval(interval);
  }, [isLoading, thinkingMessages.length]);

  // Also update message when new data comes in
  useEffect(() => {
    if (isLoading && parsedResponses.length > 0) {
      // This will update the message whenever we receive new content
      setThinkingMessageIndex((prev) => (prev + 1) % thinkingMessages.length);
    }
  }, [parsedResponses.length, isLoading, thinkingMessages.length]);
  
  // Timer effect to update elapsed time
  useEffect(() => {
    if (!isLoading || !startTime) return;
    
    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      setElapsedTime(elapsed);
    }, 1000);
    
    return () => clearInterval(timer);
  }, [isLoading, startTime]);

  // Handle typewriter effect for text content
  useEffect(() => {
    // Find any content items that are still animating
    const animatingItems = parsedResponses.filter(
      (item) => item.type === "text" && item.isAnimating
    );

    if (animatingItems.length === 0) return;

    // Process the latest animating item
    const itemIndex = parsedResponses.findIndex((item) => item.isAnimating);

    if (itemIndex === -1) return;

    const item = parsedResponses[itemIndex];
    const fullText = item.content;
    const currentText = item.displayedContent || "";

    // If we've displayed all characters, mark as done
    if (currentText.length >= fullText.length) {
      setParsedResponses((prev) => {
        const updated = [...prev];
        updated[itemIndex].isAnimating = false;
        updated[itemIndex].displayedContent = fullText;
        return updated;
      });
      return;
    }

    // Otherwise, add the next character with a delay
    const timer = setTimeout(() => {
      setParsedResponses((prev) => {
        const updated = [...prev];
        // Add one more character
        updated[itemIndex].displayedContent = fullText.substring(
          0,
          (updated[itemIndex].displayedContent || "").length + 1
        );
        return updated;
      });
    }, typingSpeed);

    return () => clearTimeout(timer);
  }, [parsedResponses, typingSpeed]);
  const [error, setError] = useState("");
  const [debugVisible, setDebugVisible] = useState(false);

  // Reference to the active fetch controller
  const fetchControllerRef = useRef<AbortController | null>(null);

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  // Parse response JSON and extract content
  const parseJsonLine = (line: string) => {
    try {
      if (!line.trim()) return;

      // For debug display
      setResponse((prev) => prev + line + "\n");

      // Parse the JSON
      const json = JSON.parse(line) as MessageWrapper;

      // Handle different response types
      if (json.type === "assistant" && json.message?.content) {
        // Process each content block
        json.message.content.forEach((item) => {
          if (item.type === "text" && "text" in item) {
            // Handle text content
            const textContent = item.text || "";
            const grafanaLinks = extractGrafanaLinks(textContent);

            setParsedResponses((prev) => {
              // Get previous timestamp if it exists
              const prevTimestamp = prev.length > 0 ? prev[prev.length - 1].timestamp : startTime;
              const now = Date.now();
              
              return [
                ...prev,
                {
                  type: "text",
                  content: textContent,
                  displayedContent: "", // Start empty for typewriter effect
                  isAnimating: true, // Mark as currently animating
                  grafanaLinks: grafanaLinks.length > 0 ? grafanaLinks : undefined,
                  timestamp: now,
                  outputTokens: json.usage?.output_tokens || 0,
                },
              ];
            });
          } else if (
            item.type === "tool_use" &&
            "name" in item &&
            "input" in item
          ) {
            // Handle tool use content
            setParsedResponses((prev) => {
              const now = Date.now();
              // Get previous timestamp if it exists
              const prevTimestamp = prev.length > 0 ? prev[prev.length - 1].timestamp : startTime;
              
              return [
                ...prev,
                {
                  type: "tool_use",
                  content: "",
                  toolName: item.name,
                  toolInput: item.input,
                  timestamp: now,
                  outputTokens: json.usage?.output_tokens || 0,
                },
              ];
            });
          }
        });
      } else if (json.type === "content_block_delta") {
        if (json.delta?.type === "text" && json.delta.text) {
          setParsedResponses((prev) => {
            const now = Date.now();
            
            if (prev.length > 0 && prev[prev.length - 1].type === "text") {
              const updated = [...prev];
              updated[updated.length - 1].content += json.delta.text;
              updated[updated.length - 1].isAnimating = true;
              
              // Re-extract Grafana links from the updated content
              const fullContent = updated[updated.length - 1].content;
              updated[updated.length - 1].grafanaLinks = extractGrafanaLinks(fullContent);
              
              // Update token count and timestamp
              if (json.usage?.output_tokens) {
                updated[updated.length - 1].outputTokens = json.usage.output_tokens;
              }
              updated[updated.length - 1].timestamp = now;
              
              return updated;
            } else {
              // Get previous timestamp if it exists
              const prevTimestamp = prev.length > 0 ? prev[prev.length - 1].timestamp : startTime;
              const textContent = json.delta.text;
              
              return [
                ...prev,
                {
                  type: "text",
                  content: textContent,
                  displayedContent: "", // Start empty for typewriter effect
                  isAnimating: true, // Mark as currently animating
                  grafanaLinks: extractGrafanaLinks(textContent),
                  timestamp: now,
                  outputTokens: json.usage?.output_tokens || 0,
                },
              ];
            }
          });
        }
      } else if (json.error) {
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
    // Scroll the whole window to the bottom
    const scrollToBottom = () => {
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: "smooth",
      });
    };

    // Execute scroll after DOM updates
    requestAnimationFrame(scrollToBottom);

    // Also try with a timer as a backup (some browsers need this)
    const timer = setTimeout(scrollToBottom, 100);

    return () => clearTimeout(timer);
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
    
    // Start the timer
    const now = Date.now();
    setStartTime(now);
    setElapsedTime(0);

    // Create a new AbortController
    fetchControllerRef.current = new AbortController();

    // Enable streaming directly
    try {
      // Use the Fetch API with appropriate settings
      const response = await fetch("/api/grafana_mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ query }),
        signal: fetchControllerRef.current.signal,
        // These are critical for proper streaming
        cache: "no-store",
        // @ts-ignore - This is not in the type defs but is supported
        duplex: "half",
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
        const lines = buffer.split("\n");

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
      if (err.name === "AbortError") {
        setError("Request cancelled");
      } else {
        console.error("Fetch error:", err);
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

      <ResultsSection>
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
                      {renderTextWithLinks(
                        (item.displayedContent !== undefined
                          ? item.displayedContent
                          : item.content
                        )?.trim() || ""
                      )}
                    </ResponseText>

                    {/* Show metadata for completed chunks */}
                    {!item.isAnimating && (
                      <ChunkMetadata>
                        {item.outputTokens ? `${item.outputTokens} tokens` : ''}
                        {item.timestamp && index > 0 && parsedResponses[index-1].timestamp ? 
                          ` • Generated in ${((item.timestamp - (parsedResponses[index-1].timestamp || 0)) / 1000).toFixed(2)}s` : 
                          item.timestamp && startTime ? 
                          ` • Generated in ${((item.timestamp - (startTime || 0)) / 1000).toFixed(2)}s` : 
                          ''
                        }
                      </ChunkMetadata>
                    )}

                    {/* Render Grafana embeds if links are present */}
                    {item.grafanaLinks && item.grafanaLinks.length > 0 && (
                      <Box mt={2}>
                        {item.grafanaLinks.map((link, i) => (
                          <GrafanaEmbed
                            key={i}
                            dashboardId={link.dashboardId}
                          />
                        ))}
                      </Box>
                    )}
                  </>
                ) : item.type === "tool_use" && item.toolName ? (
                  <ToolUseBlock>
                    <Box
                      display="flex"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <Box display="flex" alignItems="center">
                        <ToolIcon toolName={item.toolName} />
                        <ToolName variant="subtitle2">
                          Tool: {item.toolName}
                        </ToolName>
                      </Box>
                      <IconButton
                        onClick={() =>
                          setExpandedTools((prev) => ({
                            ...prev,
                            [index]: !prev[index],
                          }))
                        }
                        size="small"
                      >
                        {expandedTools[index] ? (
                          <KeyboardArrowUpIcon />
                        ) : (
                          <KeyboardArrowDownIcon />
                        )}
                      </IconButton>
                    </Box>
                    <Collapse in={expandedTools[index]} timeout="auto">
                      <ToolInput>
                        {JSON.stringify(item.toolInput, null, 2)}
                      </ToolInput>
                    </Collapse>
                    
                    {/* Show metadata for tool use */}
                    <ChunkMetadata>
                      {item.outputTokens ? `${item.outputTokens} tokens` : ''}
                      {item.timestamp && index > 0 && parsedResponses[index-1].timestamp ? 
                        ` • Generated in ${((item.timestamp - (parsedResponses[index-1].timestamp || 0)) / 1000).toFixed(2)}s` : 
                        item.timestamp && startTime ? 
                        ` • Generated in ${((item.timestamp - (startTime || 0)) / 1000).toFixed(2)}s` : 
                        ''
                      }
                    </ChunkMetadata>
                  </ToolUseBlock>
                ) : null}
                {index < parsedResponses.length - 1 &&
                  item.type === "text" &&
                  parsedResponses[index + 1].type === "text" && <hr />}
              </div>
            ))}

            {/* Add thinking indicator at the bottom if still loading */}
            {isLoading && (
              <LoaderWrapper>
                <AISpinner />
                <Box sx={{ ml: 2 }}>
                  <Typography variant="body2">
                    {thinkingMessages[thinkingMessageIndex]}
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.7 }}>
                    Running for {formatElapsedTime(elapsedTime)}
                  </Typography>
                </Box>
              </LoaderWrapper>
            )}
          </div>
        ) : (
          !isLoading &&
          !error && (
            <Typography color="textSecondary" align="center" sx={{ mt: 5 }}>
              Run a query to see results here.
            </Typography>
          )
        )}

        {/* Show loading indicator for empty results case */}
        {isLoading && parsedResponses.length === 0 && (
          <LoaderWrapper>
            <AISpinner />
            <Box sx={{ ml: 2 }}>
              <Typography variant="body2">
                {thinkingMessages[thinkingMessageIndex]}
              </Typography>
              <Typography variant="caption" sx={{ opacity: 0.7 }}>
                Running for {formatElapsedTime(elapsedTime)}
              </Typography>
            </Box>
          </LoaderWrapper>
        )}

        {/* Debug section with raw response */}
        {debugVisible && (
          <Box
            sx={{
              marginTop: "20px",
              borderTop: `1px solid ${theme.palette.divider}`,
              paddingTop: "10px",
            }}
          >
            <Typography variant="subtitle2">Debug: Raw Response</Typography>
            <pre
              style={{
                fontSize: "0.8em",
                opacity: 0.7,
                maxHeight: "200px",
                overflowY: "auto",
                backgroundColor:
                  theme.palette.mode === "dark" ? "#121212" : "#f0f0f0",
                padding: "8px",
                borderRadius: "4px",
                color: theme.palette.mode === "dark" ? "#e0e0e0" : "#333333",
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
