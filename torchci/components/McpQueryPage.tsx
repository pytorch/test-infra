import styled from "@emotion/styled";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  Box,
  Button,
  Collapse,
  IconButton,
  Paper,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
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
const ResponseText = styled("div")(({ theme }) => ({
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
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

// Todo list styling
const TodoListBlock = styled(Paper)(({ theme }) => ({
  padding: "8px 12px",
  marginTop: "12px",
  marginBottom: "12px",
  backgroundColor: theme.palette.mode === "dark" ? "#2d2d3a" : "#f7f9fc",
  borderLeft: `4px solid ${
    theme.palette.mode === "dark" ? "#9c27b0" : "#673ab7"
  }`,
  overflow: "hidden",
}));

const TodoListTitle = styled(Typography)(({ theme }) => ({
  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  fontWeight: 500,
  marginBottom: "8px",
}));

const TodoItem = styled(Box)<{ status: string }>(({ theme, status }) => ({
  display: "flex",
  alignItems: "flex-start",
  marginBottom: "2px",
  padding: "2px 0",
  textDecoration: status === "completed" ? "line-through" : "none",
  color:
    status === "completed"
      ? theme.palette.mode === "dark"
        ? "#72bb72"
        : "#2e7d32"
      : status === "in_progress"
      ? theme.palette.mode === "dark"
        ? "#f0c674"
        : "#ed6c02"
      : "inherit",
  fontWeight: status === "in_progress" ? "bold" : "normal",
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
  color:
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.5)"
      : "rgba(0, 0, 0, 0.5)",
  textAlign: "right",
  marginTop: "4px",
  marginBottom: "16px",
  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
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

const ScrollToBottomButton = styled(Button)(({ theme }) => ({
  position: "fixed",
  bottom: "20px",
  right: "20px",
  width: "48px",
  height: "48px",
  minWidth: "48px", // Ensure consistent size (MUI button default is larger)
  borderRadius: "50%",
  backgroundColor: theme.palette.primary.main,
  color: "white",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  cursor: "pointer",
  zIndex: 2000, // Higher z-index to ensure it's above everything
  boxShadow: "0 4px 8px rgba(0, 0, 0, 0.3)",
  transition: "all 0.2s ease-in-out",
  padding: 0, // Remove default button padding
  "&:hover": {
    backgroundColor: theme.palette.primary.dark,
    transform: "scale(1.1)",
    boxShadow: "0 6px 10px rgba(0, 0, 0, 0.4)",
  },
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
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface MessageWrapper {
  type: string;
  message?: AssistantMessage;
  delta?: {
    type: string;
    text?: string;
  };
  error?: string;
  status?: string;
  subtype?: string;
  total_tokens?: number;
  total_cost?: number;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: {
    output_tokens: number;
    input_tokens?: number;
  };
  tool_use_id?: string; // For tool result messages
  tool_result?: {
    tool_use_id: string;
    type: string;
    content: { type: string; text: string }[];
  };
}

interface GrafanaLink {
  fullUrl: string;
  dashboardId: string;
}

// Type to represent a single todo item
interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

// Type to represent different types of parsed content
type ParsedContent = {
  type: "text" | "tool_use" | "todo_list";
  content: string;
  displayedContent?: string; // For typewriter effect
  toolName?: string;
  toolInput?: any;
  toolUseId?: string; // ID to match with tool results
  toolResult?: string; // The result returned from the tool
  grafanaLinks?: GrafanaLink[];
  isAnimating?: boolean; // Track if this content is still animating
  timestamp?: number; // When this content was received
  outputTokens?: number; // Number of output tokens used
  todoItems?: TodoItem[]; // For todo_list type
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
const renderTextWithLinks = (
  text: string,
  isAnimating?: boolean
): React.ReactNode => {
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

  // Add blinking cursor at the end for text that's still typing - only if explicitly animating
  if (text.length > 0 && result.length > 0 && isAnimating) {
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

// Custom hook for animated counter - completely rewritten for reliability
const useAnimatedCounter = (targetValue: number) => {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    // Simply set the display value directly to the target value
    // This ensures we always show the accurate value without animation artifacts
    setDisplayValue(targetValue);
  }, [targetValue]);

  return displayValue;
};

// Format seconds to mm:ss or hh:mm:ss
const formatElapsedTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  } else {
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
  }
};

// Format token count with K for thousands
const formatTokenCount = (count: number): string => {
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + "k";
  }
  return count.toString();
};

// Generate a unique ID for the ClickHouse console query URL
const generateQueryId = (): string => {
  // This is a simplified version of UUID v4 generation
  const hex = [];
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      hex[i] = "-";
    } else if (i === 14) {
      hex[i] = "4"; // UUID version 4
    } else {
      hex[i] = Math.floor(Math.random() * 16).toString(16);
    }
  }
  return hex.join("");
};

const CLICKHOUSE_CONSOLE_BASE_URL =
  "https://console.clickhouse.cloud/services/c9b76950-2cf3-4fa0-93bb-94a65ff5f27d/console/query/";

export const McpQueryPage = () => {
  const session = useSession();
  const theme = useTheme();
  
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState("");
  const [parsedResponses, setParsedResponses] = useState<ParsedContent[]>([]);
  // Default all tools to collapsed (false)
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>(
    {}
  );
  // Track whether all tools are currently expanded
  const [allToolsExpanded, setAllToolsExpanded] = useState(false);
  const [typingSpeed] = useState(10); // ms per character for typewriter effect
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0); // in seconds
  const [totalTokens, setTotalTokens] = useState(0); // track total tokens for display
  const [completedTokens, setCompletedTokens] = useState(0); // final token count after completion
  const [completedTime, setCompletedTime] = useState(0); // final time after completion
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true); // whether auto-scrolling is enabled
  const [showScrollButton, setShowScrollButton] = useState(false); // whether to show the scroll-to-bottom button
  const displayedTokens = useAnimatedCounter(totalTokens); // animated token display

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

      // Process timing data from result messages
      try {
        // For result type which contains timing data
        if (
          json.type === "result" &&
          json.subtype === "success" &&
          json.duration_ms
        ) {
          // Duration is in milliseconds, convert to seconds
          const durationSec = Math.round(json.duration_ms / 1000);
          // Update the elapsed time for more accuracy
          setElapsedTime(durationSec);
        }
      } catch (err) {
        console.error("Error processing message data:", err);
      }

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
              const prevTimestamp =
                prev.length > 0 ? prev[prev.length - 1].timestamp : startTime;
              const now = Date.now();

              // Get output tokens from message usage
              const outputTokens = json.message?.usage?.output_tokens || 0;

              return [
                ...prev,
                {
                  type: "text",
                  content: textContent,
                  displayedContent: "", // Start empty for typewriter effect
                  isAnimating: true, // Mark as currently animating
                  grafanaLinks:
                    grafanaLinks.length > 0 ? grafanaLinks : undefined,
                  timestamp: now,
                  outputTokens: outputTokens, // Get tokens from message usage
                },
              ];
            });
          } else if (
            item.type === "tool_use" &&
            "name" in item &&
            "input" in item
          ) {
            // Special handling for Todo tools
            if (item.name === "TodoWrite" || item.name === "TodoRead") {
              // For TodoWrite, we can directly extract todos from the input
              if (item.name === "TodoWrite" && "todos" in item.input) {
                setParsedResponses((prev) => {
                  const now = Date.now();
                  // Get todos from input
                  const todos = item.input.todos;

                  // Find if we already have a todo_list type entry
                  const todoListIndex = prev.findIndex(
                    (response) => response.type === "todo_list"
                  );

                  const updated = [...prev];

                  if (todoListIndex !== -1) {
                    // Update existing todo list
                    updated[todoListIndex] = {
                      ...updated[todoListIndex],
                      todoItems: todos,
                      timestamp: now,
                    };
                  } else {
                    // Add a new todo list at the end
                    updated.push({
                      type: "todo_list",
                      content: "Todo List",
                      todoItems: todos,
                      timestamp: now,
                    });
                  }

                  // We still need to add the tool use for now, but we'll hide its display
                  // and replace it with the result when we get the response
                  updated.push({
                    type: "tool_use",
                    content: "",
                    toolName: item.name,
                    toolInput: item.input,
                    timestamp: now,
                    outputTokens: json.message?.usage?.output_tokens || 0,
                    toolUseId: "id" in item ? item.id : undefined,
                  });

                  return updated;
                });
              } else {
                // For TodoRead or if TodoWrite doesn't have todos, add normal tool use
                // We'll process it when we get the result
                setParsedResponses((prev) => {
                  const now = Date.now();
                  return [
                    ...prev,
                    {
                      type: "tool_use",
                      content: "",
                      toolName: item.name,
                      toolInput: item.input,
                      timestamp: now,
                      outputTokens: json.message?.usage?.output_tokens || 0,
                      toolUseId: "id" in item ? item.id : undefined,
                    },
                  ];
                });
              }
            } else {
              // Normal tool use handling for non-todo tools
              setParsedResponses((prev) => {
                const now = Date.now();
                // Get previous timestamp if it exists
                const prevTimestamp =
                  prev.length > 0 ? prev[prev.length - 1].timestamp : startTime;

                // Get output tokens from message usage
                const outputTokens = json.message?.usage?.output_tokens || 0;

                return [
                  ...prev,
                  {
                    type: "tool_use",
                    content: "",
                    toolName: item.name,
                    toolInput: item.input,
                    timestamp: now,
                    outputTokens: outputTokens, // Get tokens from message usage
                    toolUseId: "id" in item ? item.id : undefined, // Save tool use ID to match with results later
                  },
                ];
              });
            }
          }
        });
      } else if (json.type === "user" && json.message?.content) {
        // Process tool results from user message
        json.message.content.forEach((item) => {
          if (item.type === "tool_result" && item.tool_use_id) {
            // Find the matching tool_use in our parsed responses
            setParsedResponses((prev) => {
              const updated = [...prev];
              const toolUseIndex = updated.findIndex(
                (response) =>
                  response.type === "tool_use" &&
                  response.toolUseId === item.tool_use_id
              );

              if (toolUseIndex !== -1) {
                // Get the tool name from the matching tool use
                const toolName = updated[toolUseIndex].toolName;

                // Process Todo tools specially
                if (toolName === "TodoWrite" || toolName === "TodoRead") {
                  try {
                    // For Todo tools, we'll parse the content to extract the todos
                    // The result should mention "Todos have been modified successfully"
                    // but we need to look at the tool input for actual todo data

                    const toolInput = updated[toolUseIndex].toolInput;

                    // Check if we have todos in the input (for TodoWrite)
                    if (
                      toolName === "TodoWrite" &&
                      toolInput &&
                      "todos" in toolInput
                    ) {
                      // Get the todos directly from the input
                      const todos = toolInput.todos;

                      // Update or create todo list
                      const todoListIndex = updated.findIndex(
                        (response) => response.type === "todo_list"
                      );

                      if (todoListIndex !== -1) {
                        // Update existing todo list
                        updated[todoListIndex] = {
                          ...updated[todoListIndex],
                          todoItems: todos,
                          timestamp: Date.now(),
                        };
                      } else {
                        // Create new todo list
                        updated.push({
                          type: "todo_list",
                          content: "Todo List",
                          todoItems: todos,
                          timestamp: Date.now(),
                        });
                      }
                    }
                    // For TodoRead, try to extract todos from the result
                    else if (toolName === "TodoRead") {
                      try {
                        // Try to parse the content as JSON
                        const resultContent = item.content?.[0]?.text || "";
                        // Parse only if the content is valid JSON and contains todos
                        if (resultContent.includes('"todos":')) {
                          const todoData = JSON.parse(resultContent);
                          if (
                            todoData &&
                            todoData.todos &&
                            Array.isArray(todoData.todos)
                          ) {
                            // Found valid todos in the result
                            const todoListIndex = updated.findIndex(
                              (response) => response.type === "todo_list"
                            );

                            if (todoListIndex !== -1) {
                              // Update existing todo list
                              updated[todoListIndex] = {
                                ...updated[todoListIndex],
                                todoItems: todoData.todos,
                                timestamp: Date.now(),
                              };
                            } else {
                              // Create new todo list
                              updated.push({
                                type: "todo_list",
                                content: "Todo List",
                                todoItems: todoData.todos,
                                timestamp: Date.now(),
                              });
                            }
                          }
                        }
                      } catch (e) {
                        console.error("Failed to parse TodoRead result:", e);
                      }
                    }

                    // For both TodoWrite and TodoRead, remove the tool use entry
                    updated.splice(toolUseIndex, 1);
                  } catch (err) {
                    console.error("Failed to process todo data:", err);
                    // Leave the tool use as is if we encounter an error
                    updated[toolUseIndex] = {
                      ...updated[toolUseIndex],
                      toolResult:
                        item.content?.[0]?.text || "No result content",
                    };
                  }
                } else {
                  // Normal tool result handling for non-todo tools
                  updated[toolUseIndex] = {
                    ...updated[toolUseIndex],
                    toolResult: item.content?.[0]?.text || "No result content",
                  };
                }
              }

              return updated;
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
              updated[updated.length - 1].grafanaLinks =
                extractGrafanaLinks(fullContent);

              // For delta updates, add a token for the chunk - this approximates token usage
              const tokenIncrement = 1;

              // Update the current chunk token count
              const currentTokens =
                updated[updated.length - 1].outputTokens || 0;
              updated[updated.length - 1].outputTokens =
                currentTokens + tokenIncrement;
              updated[updated.length - 1].timestamp = now;

              return updated;
            } else {
              // Get previous timestamp if it exists
              const prevTimestamp =
                prev.length > 0 ? prev[prev.length - 1].timestamp : startTime;
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

  // Detect when user scrolls up and disable auto-scrolling
  useEffect(() => {
    // Using a reliable way to detect if we're at the bottom
    const isAtBottom = () => {
      // Allow a small buffer (100px) to consider as "at bottom"
      const scrollPosition = window.innerHeight + window.scrollY;
      const bottomOfPage = document.body.offsetHeight - 100;
      return scrollPosition >= bottomOfPage;
    };

    // Check if we have any active typewriter animations
    const hasActiveTypewriterAnimation = () => {
      return parsedResponses.some((item) => item.isAnimating);
    };

    const handleScroll = () => {
      const atBottom = isAtBottom();
      const hasAnimation = hasActiveTypewriterAnimation();

      // Process scroll events differently based on animation state
      if (!atBottom) {
        // When user scrolls up, disable auto-scroll and show button
        // We do this regardless of loading state to better handle typewriter effects
        if (autoScrollEnabled) {
          setAutoScrollEnabled(false);
          setShowScrollButton(true);
        }
      } else if (atBottom && showScrollButton) {
        // When user manually scrolls back to bottom, hide button and re-enable auto-scroll
        setShowScrollButton(false);
        setAutoScrollEnabled(true);
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isLoading, showScrollButton, parsedResponses, autoScrollEnabled]);

  // Function to scroll to bottom and re-enable auto-scrolling when button is clicked
  const scrollToBottomAndEnable = useCallback(() => {
    // Re-enable auto-scrolling
    setAutoScrollEnabled(true);

    // Hide the button
    setShowScrollButton(false);

    // Scroll to bottom with smooth animation
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth",
    });

    console.log("Auto-scroll re-enabled and scrolled to bottom");
  }, []);

  // Auto-scroll to bottom when new responses are added, but only when enabled
  // Auto-scroll to bottom when new content is added (only when enabled)
  useEffect(() => {
    // Only run this effect when we have content, we're loading, and auto-scroll is enabled
    if (!isLoading || !autoScrollEnabled || parsedResponses.length === 0)
      return;

    // Check if there's any active animation to prevent scrolling during typewriter effect
    const hasActiveTypewriterAnimation = parsedResponses.some(
      (item) => item.isAnimating
    );
    if (hasActiveTypewriterAnimation) {
      // Skip auto-scrolling when typewriter animation is active to allow user scrolling
      return;
    }

    // Only scroll if we're not already at the bottom - this helps prevent scroll jumping
    const isAtBottom = () => {
      const scrollPosition = window.innerHeight + window.scrollY;
      const bottomOfPage = document.body.offsetHeight - 50; // Use smaller buffer for this check
      return scrollPosition >= bottomOfPage;
    };

    // Don't scroll if we're already at the bottom to avoid unnecessary operations
    if (!isAtBottom()) {
      // Scroll with smooth behavior after DOM updates
      const scrollToBottom = () => {
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: "smooth",
        });
      };

      // Use requestAnimationFrame to ensure DOM updates are applied first
      requestAnimationFrame(scrollToBottom);
    }
  }, [parsedResponses, isLoading, autoScrollEnabled]);

  // Calculate total tokens whenever parsedResponses changes
  // Avoid double counting by tracking which messages we've already counted
  const calculateTotalTokens = useCallback((responses: ParsedContent[]) => {
    // Using a Number rather than an integer to avoid overflow
    let total = 0;
    const textTokens = [];

    try {
      // First, check if we've been given empty responses
      if (!Array.isArray(responses) || responses.length === 0) {
        return 0;
      }

      // Calculate an incremental sum of token counts to detect anomalies
      for (const item of responses) {
        if (item.type === "text") {
          // Only count tokens from text cells to avoid double counting
          if (
            typeof item.outputTokens === "number" &&
            isFinite(item.outputTokens)
          ) {
            const tokenCount = Math.max(0, Number(item.outputTokens));
            textTokens.push(tokenCount);

            // Only add reasonable token counts
            if (tokenCount >= 0 && tokenCount < 10000) {
              total += tokenCount;
            } else {
              console.warn("Skipping suspicious token count:", tokenCount);
            }
          }
        }
        // Intentionally not counting tool_use tokens to avoid double counting
      }
    } catch (err) {
      console.error("Error during token calculation:", err);
      // If calculation fails, return a reasonable number instead of crashing
      return 0;
    }

    // Ensure the total is reasonable (between 0 and 20k)
    // Use Number() to ensure we're not dealing with weird type issues
    total = Number(total);

    // Handle NaN, Infinity, or negative numbers
    if (!isFinite(total) || total < 0) {
      console.warn(`Invalid token count detected: ${total}, resetting to 0`);
      total = 0;
    } else if (total > 20000) {
      console.warn(`Token count capped from ${total} to 20000`);
      total = 20000;
    }

    return total;
  }, []);

  // Dedicated effect to keep total token count in sync
  useEffect(() => {
    if (parsedResponses.length > 0) {
      const total = calculateTotalTokens(parsedResponses);
      console.log(
        "Token counter effect - total tokens:",
        total,
        "from",
        parsedResponses.length,
        "chunks"
      );

      // Only update if the value is valid and different to avoid unnecessary re-renders
      if (isFinite(total) && total >= 0 && total !== totalTokens) {
        setTotalTokens(total);
      }
    }
  }, [parsedResponses, calculateTotalTokens, totalTokens]);

  // Final scroll to bottom when loading finishes (respects auto-scroll setting)
  useEffect(() => {
    // Only scroll when loading finishes AND we have content AND auto-scroll is enabled
    if (!isLoading && parsedResponses.length > 0 && autoScrollEnabled) {
      // Check if there's any active animation to prevent scrolling during typewriter effect
      const hasActiveTypewriterAnimation = parsedResponses.some(
        (item) => item.isAnimating
      );
      if (hasActiveTypewriterAnimation) {
        // If there's still an active typewriter effect, don't force scroll
        return;
      }

      // Use a slight delay to ensure all content is fully rendered
      const finalScrollTimer = setTimeout(() => {
        // Do one final check before scrolling to make sure user hasn't scrolled away
        if (autoScrollEnabled) {
          window.scrollTo({
            top: document.body.scrollHeight,
            behavior: "smooth",
          });
          console.log("Final scroll to bottom on completion");
        }
      }, 200);

      return () => clearTimeout(finalScrollTimer);
    }
  }, [isLoading, parsedResponses.length, autoScrollEnabled, parsedResponses]);

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
    setAllToolsExpanded(false); // Reset tool expansion state
    setAutoScrollEnabled(true); // Re-enable auto-scrolling
    setShowScrollButton(false); // Hide scroll button

    // Start the timer and reset all token counts
    const now = Date.now();
    setStartTime(now);
    setElapsedTime(0);

    // Reset all token counters
    setTotalTokens(0);
    setCompletedTokens(0);
    setCompletedTime(0);

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
        
        // Handle authentication/authorization errors with specific messages
        if (response.status === 401) {
          throw new Error("Authentication required. Please sign in to continue.");
        } else if (response.status === 403) {
          throw new Error("Access denied. You need write permissions to pytorch/pytorch repository to use this tool.");
        } else {
          throw new Error(errorText || `HTTP error: ${response.status}`);
        }
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

          // Wait a short moment to ensure all state updates have processed
          setTimeout(() => {
            // Calculate the final token count using our memoized function
            const finalTokens = calculateTotalTokens(parsedResponses);

            // Store the completion time and final token count
            setCompletedTime(elapsedTime);
            setCompletedTokens(finalTokens);

            // Make sure totalTokens is consistent
            setTotalTokens(finalTokens);

            console.log("Completion - final token count:", finalTokens);

            // Stop the token animation
            setIsLoading(false);
          }, 500); // Increase timeout to ensure state updates properly

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


  // Authentication check - only allow authenticated users with access tokens
  if (
    session.status === "loading"
  ) {
    // Show loading state while checking authentication
    return (
      <McpQueryPageContainer>
        <Paper sx={{ padding: "20px", textAlign: "center" }}>
          <AISpinner />
          <Typography variant="h6" sx={{ mt: 2 }}>
            Checking authentication...
          </Typography>
        </Paper>
      </McpQueryPageContainer>
    );
  }

  if (
    session.status === "unauthenticated" ||
    !session.data?.user ||
    !(session.data as any)?.accessToken
  ) {
    // Show authentication required message
    return (
      <McpQueryPageContainer>
        <Paper sx={{ padding: "20px", textAlign: "center" }}>
          <Typography variant="h4" gutterBottom>
            Authentication Required
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            You must be logged in with write permissions to pytorch/pytorch to access this tool.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Please sign in to continue.
          </Typography>
        </Paper>
      </McpQueryPageContainer>
    );
  }

  return (
    <McpQueryPageContainer>
      {/* Floating scroll to bottom button - only shows when scrolled up during loading */}
      {showScrollButton && (
        <Tooltip title="Go to bottom and resume auto-scroll">
          <ScrollToBottomButton
            variant="contained"
            color="primary"
            onClick={scrollToBottomAndEnable}
            aria-label="Scroll to bottom and resume auto-scroll"
          >
            <ArrowDownwardIcon />
          </ScrollToBottomButton>
        </Tooltip>
      )}

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
            placeholder="Example: Make a graph of the number of failing jobs per day  (Tip: Ctrl+Enter to submit)"
            variant="outlined"
            disabled={isLoading}
            onKeyDown={(e) => {
              // Submit on Ctrl+Enter or Cmd+Enter
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                if (!isLoading && query.trim()) {
                  handleSubmit(e);
                }
              }
            }}
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
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mb: 2,
          }}
        >
          <Typography variant="h6">Results</Typography>
          {parsedResponses.length > 0 &&
            parsedResponses.some((item) => item.type === "tool_use") && (
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  // Toggle between expand all and collapse all
                  if (allToolsExpanded) {
                    // Collapse all - set to empty object to collapse everything
                    setExpandedTools({});
                    setAllToolsExpanded(false);
                  } else {
                    // Expand all - set all tool indices to true
                    const allExpanded = parsedResponses.reduce(
                      (acc, _, index) => {
                        if (parsedResponses[index].type === "tool_use") {
                          acc[index] = true;
                        }
                        return acc;
                      },
                      {} as Record<number, boolean>
                    );
                    setExpandedTools(allExpanded);
                    setAllToolsExpanded(true);
                  }
                }}
              >
                {allToolsExpanded ? "Collapse all tools" : "Expand all tools"}
              </Button>
            )}
        </Box>
        {error && (
          <Typography color="error" paragraph>
            {error}
          </Typography>
        )}

        {parsedResponses.length > 0 ? (
          <div>
            {/* Map all non-todo_list items first */}
            {parsedResponses
              .filter((item) => item.type !== "todo_list")
              .map((item, index) => (
                <div key={`content-${index}`}>
                  {item.type === "text" ? (
                    <>
                      <ResponseText>
                        {renderTextWithLinks(
                          (item.displayedContent !== undefined
                            ? item.displayedContent
                            : item.content
                          )?.trim() || "",
                          item.isAnimating
                        )}
                      </ResponseText>

                      {/* Show metadata for completed chunks */}
                      {!item.isAnimating && (
                        <ChunkMetadata>
                          {item.timestamp &&
                          index > 0 &&
                          parsedResponses[index - 1].timestamp
                            ? `Generated in ${(
                                (item.timestamp -
                                  (parsedResponses[index - 1].timestamp || 0)) /
                                1000
                              ).toFixed(2)}s`
                            : item.timestamp && startTime
                            ? `Generated in ${(
                                (item.timestamp - (startTime || 0)) /
                                1000
                              ).toFixed(2)}s`
                            : ""}
                          {item.outputTokens
                            ? ` • ${formatTokenCount(item.outputTokens)} tokens`
                            : ""}
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
                  ) : item.type === "todo_list" && item.todoItems ? (
                    <TodoListBlock>
                      <TodoListTitle variant="subtitle1">
                        <Box
                          sx={{ display: "flex", alignItems: "center", gap: 1 }}
                        >
                          <CheckBoxIcon
                            sx={{
                              color:
                                theme.palette.mode === "dark"
                                  ? "#9c27b0"
                                  : "#673ab7",
                            }}
                          />
                          Todo List
                        </Box>
                      </TodoListTitle>

                      <Box sx={{ pl: 1 }}>
                        {item.todoItems.map((todo) => (
                          <TodoItem key={todo.id} status={todo.status}>
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: 1.5,
                              }}
                            >
                              {todo.status === "completed" ? (
                                <CheckBoxIcon
                                  color="success"
                                  sx={{ mt: 0.3 }}
                                />
                              ) : (
                                <CheckBoxOutlineBlankIcon
                                  sx={{
                                    mt: 0.3,
                                    color:
                                      todo.status === "in_progress"
                                        ? theme.palette.mode === "dark"
                                          ? "#f0c674"
                                          : "#ed6c02"
                                        : "text.secondary",
                                  }}
                                />
                              )}
                              <Typography
                                variant="body2"
                                component="span"
                                sx={{
                                  wordBreak: "break-word",
                                  fontFamily:
                                    "Roboto, 'Helvetica Neue', Arial, sans-serif",
                                }}
                              >
                                {todo.content}
                              </Typography>
                            </Box>
                          </TodoItem>
                        ))}
                      </Box>

                      <Typography
                        variant="caption"
                        sx={{
                          display: "block",
                          mt: 2,
                          textAlign: "right",
                          color: "text.secondary",
                          fontStyle: "italic",
                        }}
                      >
                        Last updated:{" "}
                        {item.timestamp
                          ? new Date(item.timestamp).toLocaleTimeString()
                          : "Unknown"}
                      </Typography>
                    </TodoListBlock>
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
                        {/* Tool Input */}
                        <Typography
                          variant="caption"
                          sx={{
                            display: "block",
                            mt: 1,
                            mb: 0.5,
                            color: "text.secondary",
                          }}
                        >
                          Input:
                        </Typography>
                        <ToolInput>
                          {JSON.stringify(item.toolInput, null, 2)}
                        </ToolInput>

                        {/* Tool Result (if available) */}
                        {item.toolResult && (
                          <>
                            <Typography
                              variant="caption"
                              sx={{
                                display: "block",
                                mt: 2,
                                mb: 0.5,
                                color: "text.secondary",
                              }}
                            >
                              Result:
                            </Typography>
                            <ToolInput
                              sx={{
                                backgroundColor:
                                  theme.palette.mode === "dark"
                                    ? "#252e3d"
                                    : "#f0f7ff",
                                borderLeft: `4px solid ${
                                  theme.palette.mode === "dark"
                                    ? "#4caf50"
                                    : "#2e7d32"
                                }`,
                              }}
                            >
                              {(() => {
                                try {
                                  // Try to parse and pretty print JSON responses
                                  const parsed = JSON.parse(item.toolResult);
                                  return JSON.stringify(parsed, null, 2);
                                } catch (e) {
                                  // If not valid JSON, return as is
                                  return item.toolResult;
                                }
                              })()}
                            </ToolInput>
                          </>
                        )}

                        {/* Add ClickHouse button if this is a ClickHouse tool */}
                        {item.toolName?.toLowerCase().includes("clickhouse") &&
                          item.toolInput?.query && (
                            <Box sx={{ mt: 2, textAlign: "right" }}>
                              <Tooltip
                                title="This will copy the query and open a new page in ClickHouse. Paste the query to run it there"
                                arrow
                              >
                                <Button
                                  variant="outlined"
                                  size="small"
                                  startIcon={<ContentCopyIcon />}
                                  onClick={() => {
                                    const query =
                                      typeof item.toolInput.query === "string"
                                        ? item.toolInput.query
                                        : JSON.stringify(item.toolInput.query);

                                    navigator.clipboard.writeText(query);
                                    window.open(
                                      CLICKHOUSE_CONSOLE_BASE_URL +
                                        generateQueryId(),
                                      "_blank"
                                    );
                                  }}
                                >
                                  Copy query and go to ClickHouse
                                </Button>
                              </Tooltip>
                            </Box>
                          )}
                      </Collapse>

                      {/* Show metadata for tool use - only tokens */}
                      <ChunkMetadata>
                        {item.outputTokens
                          ? `${formatTokenCount(item.outputTokens)} tokens`
                          : ""}
                      </ChunkMetadata>
                    </ToolUseBlock>
                  ) : null}
                  {index < parsedResponses.length - 1 &&
                    item.type === "text" &&
                    parsedResponses[index + 1].type === "text" && <hr />}
                </div>
              ))}

            {/* Display todo list at the bottom if it exists */}
            {parsedResponses
              .filter((item) => item.type === "todo_list")
              .map((item, index) => (
                <div key={`todo-${index}`}>
                  {item.todoItems && (
                    <TodoListBlock>
                      <Box>
                        {item.todoItems.map((todo) => (
                          <TodoItem key={todo.id} status={todo.status}>
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: 1,
                              }}
                            >
                              {todo.status === "completed" ? (
                                <CheckBoxIcon
                                  color="success"
                                  sx={{ mt: 0.15, fontSize: "1rem" }}
                                />
                              ) : (
                                <CheckBoxOutlineBlankIcon
                                  sx={{
                                    mt: 0.15,
                                    fontSize: "1rem",
                                    color:
                                      todo.status === "in_progress"
                                        ? theme.palette.mode === "dark"
                                          ? "#f0c674"
                                          : "#ed6c02"
                                        : "text.secondary",
                                  }}
                                />
                              )}
                              <Typography
                                variant="body2"
                                component="span"
                                sx={{
                                  wordBreak: "break-word",
                                  fontSize: "0.875rem",
                                  fontFamily:
                                    "Roboto, 'Helvetica Neue', Arial, sans-serif",
                                }}
                              >
                                {todo.content}
                              </Typography>
                            </Box>
                          </TodoItem>
                        ))}
                      </Box>
                    </TodoListBlock>
                  )}
                </div>
              ))}

            {/* Add thinking indicator at the bottom if still loading */}
            {isLoading ? (
              <LoaderWrapper>
                <AISpinner />
                <Box sx={{ ml: 2 }}>
                  <Typography variant="body2">
                    {thinkingMessages[thinkingMessageIndex]}
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.7 }}>
                    Running for {formatElapsedTime(elapsedTime)} •{" "}
                    {formatTokenCount(displayedTokens)} tokens
                  </Typography>
                </Box>
              </LoaderWrapper>
            ) : (
              completedTokens > 0 && (
                // Show completion summary when finished - with higher z-index and sticky position
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "flex-end",
                    alignItems: "center",
                    mt: 3,
                    p: 2,
                    borderTop: "1px solid",
                    borderTopColor: "divider",
                    backgroundColor:
                      theme.palette.mode === "dark"
                        ? "rgba(30,30,30,0.95)"
                        : "rgba(250,250,250,0.95)",
                    borderRadius: "0 0 8px 8px",
                    position: "sticky",
                    bottom: 0,
                    zIndex: 10,
                    boxShadow: "0 -2px 10px rgba(0,0,0,0.1)",
                  }}
                >
                  <Typography
                    variant="body2"
                    color="text.primary"
                    sx={{ fontWeight: "medium" }}
                  >
                    Completed in {formatElapsedTime(completedTime)} • Total:{" "}
                    {formatTokenCount(completedTokens)} tokens
                  </Typography>
                </Box>
              )
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
                Running for {formatElapsedTime(elapsedTime)} •{" "}
                {formatTokenCount(displayedTokens)} tokens
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
