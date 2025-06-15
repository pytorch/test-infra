import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import {
  Box,
  Button,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import AISpinner from "./AISpinner";
import { GrafanaEmbed } from "./TorchAgentPage/GrafanaEmbed";
import {
  useAnimatedCounter,
  useAutoScroll,
  useThinkingMessages,
  useTokenCalculator,
} from "./TorchAgentPage/hooks";
import {
  ChunkMetadata,
  LoaderWrapper,
  QuerySection,
  ResponseText,
  ResultsSection,
  ScrollToBottomButton,
  TorchAgentPageContainer,
} from "./TorchAgentPage/styles";
import { TodoList } from "./TorchAgentPage/TodoList";
import { ToolUse } from "./TorchAgentPage/ToolUse";
import { MessageWrapper, ParsedContent } from "./TorchAgentPage/types";
import {
  extractGrafanaLinks,
  formatElapsedTime,
  formatTokenCount,
  renderTextWithLinks,
} from "./TorchAgentPage/utils";

export const TorchAgentPage = () => {
  const session = useSession();
  const theme = useTheme();

  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState("");
  const [parsedResponses, setParsedResponses] = useState<ParsedContent[]>([]);
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>(
    {}
  );
  const [allToolsExpanded, setAllToolsExpanded] = useState(false);
  const [typingSpeed] = useState(10);
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [completedTokens, setCompletedTokens] = useState(0);
  const [completedTime, setCompletedTime] = useState(0);
  const [error, setError] = useState("");
  const [debugVisible, setDebugVisible] = useState(false);

  const fetchControllerRef = useRef<AbortController | null>(null);

  const thinkingMessages = useThinkingMessages();
  const displayedTokens = useAnimatedCounter(totalTokens);
  const calculateTotalTokens = useTokenCalculator();
  const { showScrollButton, scrollToBottomAndEnable, resetAutoScroll } =
    useAutoScroll(isLoading, parsedResponses);

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  // Rotate through thinking messages every 6 seconds
  useEffect(() => {
    if (!isLoading) return;

    const interval = setInterval(() => {
      setThinkingMessageIndex((prev) => (prev + 1) % thinkingMessages.length);
    }, 6000);

    return () => clearInterval(interval);
  }, [isLoading, thinkingMessages.length]);

  // Also update message when new data comes in
  useEffect(() => {
    if (isLoading && parsedResponses.length > 0) {
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
    const animatingItems = parsedResponses.filter(
      (item) => item.type === "text" && item.isAnimating
    );

    if (animatingItems.length === 0) return;

    const itemIndex = parsedResponses.findIndex((item) => item.isAnimating);
    if (itemIndex === -1) return;

    const item = parsedResponses[itemIndex];
    const fullText = item.content;
    const currentText = item.displayedContent || "";

    if (currentText.length >= fullText.length) {
      setParsedResponses((prev) => {
        const updated = [...prev];
        updated[itemIndex].isAnimating = false;
        updated[itemIndex].displayedContent = fullText;
        return updated;
      });
      return;
    }

    const timer = setTimeout(() => {
      setParsedResponses((prev) => {
        const updated = [...prev];
        updated[itemIndex].displayedContent = fullText.substring(
          0,
          (updated[itemIndex].displayedContent || "").length + 1
        );
        return updated;
      });
    }, typingSpeed);

    return () => clearTimeout(timer);
  }, [parsedResponses, typingSpeed]);

  // Calculate total tokens whenever parsedResponses changes
  useEffect(() => {
    if (parsedResponses.length > 0) {
      const total = calculateTotalTokens(parsedResponses);
      if (isFinite(total) && total >= 0 && total !== totalTokens) {
        setTotalTokens(total);
      }
    }
  }, [parsedResponses, calculateTotalTokens, totalTokens]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      if (fetchControllerRef.current) {
        fetchControllerRef.current.abort();
        fetchControllerRef.current = null;
      }
    };
  }, []);

  // Parse response JSON and extract content
  const parseJsonLine = (line: string) => {
    try {
      if (!line.trim()) return;

      setResponse((prev) => prev + line + "\n");
      const json = JSON.parse(line) as MessageWrapper;

      // Process timing data from result messages
      if (
        json.type === "result" &&
        json.subtype === "success" &&
        json.duration_ms
      ) {
        const durationSec = Math.round(json.duration_ms / 1000);
        setElapsedTime(durationSec);
      }

      // Handle different response types
      if (json.type === "assistant" && json.message?.content) {
        json.message.content.forEach((item) => {
          if (item.type === "text" && "text" in item) {
            const textContent = item.text || "";
            const grafanaLinks = extractGrafanaLinks(textContent);

            setParsedResponses((prev) => {
              const now = Date.now();
              const outputTokens = json.message?.usage?.output_tokens || 0;

              return [
                ...prev,
                {
                  type: "text",
                  content: textContent,
                  displayedContent: "",
                  isAnimating: true,
                  grafanaLinks:
                    grafanaLinks.length > 0 ? grafanaLinks : undefined,
                  timestamp: now,
                  outputTokens: outputTokens,
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
              if (item.name === "TodoWrite" && "todos" in item.input) {
                setParsedResponses((prev) => {
                  const now = Date.now();
                  const todos = item.input.todos;

                  const todoListIndex = prev.findIndex(
                    (response) => response.type === "todo_list"
                  );

                  const updated = [...prev];

                  if (todoListIndex !== -1) {
                    updated[todoListIndex] = {
                      ...updated[todoListIndex],
                      todoItems: todos,
                      timestamp: now,
                    };
                  } else {
                    updated.push({
                      type: "todo_list",
                      content: "Todo List",
                      todoItems: todos,
                      timestamp: now,
                    });
                  }

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
              setParsedResponses((prev) => {
                const now = Date.now();
                const outputTokens = json.message?.usage?.output_tokens || 0;

                return [
                  ...prev,
                  {
                    type: "tool_use",
                    content: "",
                    toolName: item.name,
                    toolInput: item.input,
                    timestamp: now,
                    outputTokens: outputTokens,
                    toolUseId: "id" in item ? item.id : undefined,
                  },
                ];
              });
            }
          }
        });
      } else if (json.type === "user" && json.message?.content) {
        json.message.content.forEach((item) => {
          if (item.type === "tool_result" && item.tool_use_id) {
            setParsedResponses((prev) => {
              const updated = [...prev];
              const toolUseIndex = updated.findIndex(
                (response) =>
                  response.type === "tool_use" &&
                  response.toolUseId === item.tool_use_id
              );

              if (toolUseIndex !== -1) {
                const toolName = updated[toolUseIndex].toolName;

                if (toolName === "TodoWrite" || toolName === "TodoRead") {
                  try {
                    const toolInput = updated[toolUseIndex].toolInput;

                    if (
                      toolName === "TodoWrite" &&
                      toolInput &&
                      "todos" in toolInput
                    ) {
                      const todos = toolInput.todos;
                      const todoListIndex = updated.findIndex(
                        (response) => response.type === "todo_list"
                      );

                      if (todoListIndex !== -1) {
                        updated[todoListIndex] = {
                          ...updated[todoListIndex],
                          todoItems: todos,
                          timestamp: Date.now(),
                        };
                      } else {
                        updated.push({
                          type: "todo_list",
                          content: "Todo List",
                          todoItems: todos,
                          timestamp: Date.now(),
                        });
                      }
                    } else if (toolName === "TodoRead") {
                      try {
                        const resultContent = item.content?.[0]?.text || "";
                        if (resultContent.includes('"todos":')) {
                          const todoData = JSON.parse(resultContent);
                          if (
                            todoData &&
                            todoData.todos &&
                            Array.isArray(todoData.todos)
                          ) {
                            const todoListIndex = updated.findIndex(
                              (response) => response.type === "todo_list"
                            );

                            if (todoListIndex !== -1) {
                              updated[todoListIndex] = {
                                ...updated[todoListIndex],
                                todoItems: todoData.todos,
                                timestamp: Date.now(),
                              };
                            } else {
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

                    updated.splice(toolUseIndex, 1);
                  } catch (err) {
                    console.error("Failed to process todo data:", err);
                    updated[toolUseIndex] = {
                      ...updated[toolUseIndex],
                      toolResult:
                        item.content?.[0]?.text || "No result content",
                    };
                  }
                } else {
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
              updated[updated.length - 1].content += json.delta?.text || "";
              updated[updated.length - 1].isAnimating = true;

              const fullContent = updated[updated.length - 1].content;
              updated[updated.length - 1].grafanaLinks =
                extractGrafanaLinks(fullContent);

              const tokenIncrement = 1;
              const currentTokens =
                updated[updated.length - 1].outputTokens || 0;
              updated[updated.length - 1].outputTokens =
                currentTokens + tokenIncrement;
              updated[updated.length - 1].timestamp = now;

              return updated;
            } else {
              const textContent = json.delta?.text || "";

              return [
                ...prev,
                {
                  type: "text",
                  content: textContent,
                  displayedContent: "",
                  isAnimating: true,
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
      console.log("Failed to parse:", line);
    }
  };

  const cancelRequest = () => {
    if (fetchControllerRef.current) {
      fetchControllerRef.current.abort();
      fetchControllerRef.current = null;
      setIsLoading(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!query.trim()) {
      setError("Query cannot be empty");
      return;
    }

    cancelRequest();

    setIsLoading(true);
    setResponse("");
    setParsedResponses([]);
    setError("");
    setAllToolsExpanded(false);
    resetAutoScroll();

    const now = Date.now();
    setStartTime(now);
    setElapsedTime(0);
    setTotalTokens(0);
    setCompletedTokens(0);
    setCompletedTime(0);

    fetchControllerRef.current = new AbortController();

    try {
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
        cache: "no-store",
        // @ts-ignore
        duplex: "half",
      });

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 401) {
          throw new Error(
            "Authentication required. Please sign in to continue."
          );
        } else if (response.status === 403) {
          throw new Error(
            "Access denied. You need write permissions to pytorch/pytorch repository to use this tool."
          );
        } else {
          throw new Error(errorText || `HTTP error: ${response.status}`);
        }
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (fetchControllerRef.current === null) break;

        const { done, value } = await reader.read();

        if (done) {
          if (buffer.trim()) {
            parseJsonLine(buffer.trim());
          }

          setTimeout(() => {
            const finalTokens = calculateTotalTokens(parsedResponses);
            setCompletedTime(elapsedTime);
            setCompletedTokens(finalTokens);
            setTotalTokens(finalTokens);
            setIsLoading(false);
          }, 500);

          break;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;

        const lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].trim()) {
            parseJsonLine(lines[i].trim());
          }
        }

        buffer = lines[lines.length - 1];
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Request cancelled");
      } else {
        console.error("Fetch error:", err);
        setError(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      setIsLoading(false);
    }
  };

  // Authentication check
  if (session.status === "loading") {
    return (
      <TorchAgentPageContainer>
        <QuerySection sx={{ padding: "20px", textAlign: "center" }}>
          <AISpinner />
          <Typography variant="h6" sx={{ mt: 2 }}>
            Checking authentication...
          </Typography>
        </QuerySection>
      </TorchAgentPageContainer>
    );
  }

  if (
    session.status === "unauthenticated" ||
    !session.data?.user ||
    !(session.data as any)?.accessToken
  ) {
    return (
      <TorchAgentPageContainer>
        <QuerySection sx={{ padding: "20px", textAlign: "center" }}>
          <Typography variant="h4" gutterBottom>
            Authentication Required
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            You must be logged in with write permissions to pytorch/pytorch to
            access this tool.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Please sign in to continue.
          </Typography>
        </QuerySection>
      </TorchAgentPageContainer>
    );
  }

  const renderContent = () => {
    if (parsedResponses.length === 0) {
      if (isLoading) {
        return (
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
        );
      }
      return (
        <Typography color="textSecondary" align="center" sx={{ mt: 5 }}>
          Run a query to see results here.
        </Typography>
      );
    }

    return (
      <div>
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

                  {item.grafanaLinks && item.grafanaLinks.length > 0 && (
                    <Box mt={2}>
                      {item.grafanaLinks.map((link, i) => (
                        <GrafanaEmbed key={i} dashboardId={link.dashboardId} />
                      ))}
                    </Box>
                  )}
                </>
              ) : item.type === "tool_use" && item.toolName ? (
                <ToolUse
                  toolName={item.toolName}
                  toolInput={item.toolInput}
                  toolResult={item.toolResult}
                  outputTokens={item.outputTokens}
                  isExpanded={expandedTools[index] || false}
                  onToggleExpand={() =>
                    setExpandedTools((prev) => ({
                      ...prev,
                      [index]: !prev[index],
                    }))
                  }
                />
              ) : null}
            </div>
          ))}

        {parsedResponses
          .filter((item) => item.type === "todo_list")
          .map((item, index) => (
            <div key={`todo-${index}`}>
              {item.todoItems && (
                <TodoList
                  todoItems={item.todoItems}
                  timestamp={item.timestamp}
                />
              )}
            </div>
          ))}

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
    );
  };

  return (
    <TorchAgentPageContainer>
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
        TorchAgent
      </Typography>

      <Typography
        variant="body1"
        paragraph
        sx={{
          mb: 3,
          p: 2,
          backgroundColor: "background.paper",
          borderRadius: 1,
          border: "1px solid",
          borderColor: "divider",
        }}
      >
        Welcome to TorchAgent, your intelligent assistant for PyTorch
        infrastructure analysis and monitoring. This tool helps you create
        custom time-series visualizations, analyze CI/CD metrics, and gain
        insights into the PyTorch development workflow. Simply describe what
        you&apos;d like to explore, and TorchAgent will generate the appropriate
        queries and dashboards for you. Data we have access to:
        <ul>
          <li>
            PyTorch GitHub repository data (comments, issues, PRs, including
            text inside of these)
          </li>
          <li>
            PyTorch GitHub Actions CI data (build/test/workflow results,
            error log classifications, duration, runner types)
          </li>
          <li>
            CI cost / duration data: how long does the average job/workflow run)
          </li>
          <li>Benchmarking data in the benchmarking database</li>
        </ul>
      </Typography>

      <Typography variant="body1" paragraph>
        What can I help you graph today?
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
                  if (allToolsExpanded) {
                    setExpandedTools({});
                    setAllToolsExpanded(false);
                  } else {
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

        {renderContent()}

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
    </TorchAgentPageContainer>
  );
};
