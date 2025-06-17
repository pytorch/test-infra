import { Box, Button, Typography, useTheme } from "@mui/material";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import AISpinner from "./AISpinner";
import { ChatHistorySidebar } from "./TorchAgentPage/ChatHistorySidebar";
import { GrafanaEmbed } from "./TorchAgentPage/GrafanaEmbed";
import { HeaderSection } from "./TorchAgentPage/HeaderSection";
import {
  useAnimatedCounter,
  useAutoScroll,
  useThinkingMessages,
  useTokenCalculator,
} from "./TorchAgentPage/hooks";
import { LoadingDisplay } from "./TorchAgentPage/LoadingDisplay";
import {
  ChunkMetadata,
  LoaderWrapper,
  QuerySection,
  ResponseText,
  ResultsSection,
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
import { WelcomeSection } from "./TorchAgentPage/WelcomeSection";

interface ChatSession {
  sessionId: string;
  timestamp: string;
  date: string;
  filename: string;
  key: string;
  status?: string;
  title?: string;
  displayedTitle?: string;
}

export const TorchAgentPage = () => {
  const session = useSession();
  const theme = useTheme();

  const featureRequestUrl =
    "https://github.com/pytorch/test-infra/issues/new?title=" +
    encodeURIComponent("[TorchAgent][featurerequest]") +
    "&body=" +
    encodeURIComponent("Please describe your feature request here.");
  const bugReportUrl =
    "https://github.com/pytorch/test-infra/issues/new?title=" +
    encodeURIComponent("[TorchAgent][bug]") +
    "&body=" +
    encodeURIComponent("Please describe the bug you encountered.");

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
  const hasFetchedTitleRef = useRef(false);

  // Chat history state
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const chatHistoryRef = useRef<ChatSession[]>([]);
  useEffect(() => {
    chatHistoryRef.current = chatHistory;
  }, [chatHistory]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const fetchControllerRef = useRef<AbortController | null>(null);

  const thinkingMessages = useThinkingMessages();
  const displayedTokens = useAnimatedCounter(totalTokens);
  const calculateTotalTokens = useTokenCalculator();
  const { showScrollButton, scrollToBottomAndEnable, resetAutoScroll } =
    useAutoScroll(isLoading, parsedResponses);

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  // Fetch chat history on component mount
  const fetchChatHistory = async (showLoading = false) => {
    if (!session.data?.user) return;

    if (showLoading) {
      setIsHistoryLoading(true);
    }
    try {
      const response = await fetch("/api/torchagent-get-history");
      if (response.ok) {
        const data = await response.json();
        setChatHistory(data.sessions || []);
        const hasInProgress = (data.sessions || []).some(
          (s: ChatSession) => s.status === "in_progress"
        );
        if (hasInProgress && !pollingRef.current) {
          pollingRef.current = setInterval(fetchChatHistory, 10000);
        } else if (!hasInProgress && pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      } else {
        console.error("Failed to fetch chat history");
      }
    } catch (error) {
      console.error("Error fetching chat history:", error);
    } finally {
      if (showLoading) {
        setIsHistoryLoading(false);
      }
    }
  };

  // Load a specific chat session
  const loadChatSession = async (sessionId: string) => {
    setIsSessionLoading(true);
    // Clear existing content while loading
    setParsedResponses([]);
    setResponse("");
    setError("");

    try {
      const response = await fetch(
        `/api/torchagent-get-chat-history?sessionId=${sessionId}`
      );
      if (response.ok) {
        const sessionData = await response.json();
        console.log("Loaded session data:", sessionData);

        // The messages array contains the same format as streaming data
        if (sessionData.messages && Array.isArray(sessionData.messages)) {
          // Clear the query input for historical chats
          setQuery("");

          // Process each message directly
          let fullResponse = "";

          // Clear existing parsed responses
          setParsedResponses([]);

          // First, process user messages (queries/prompts) - these should appear first
          sessionData.messages.forEach((msg: any) => {
            if (msg.type === "user_message" && msg.content) {
              const textContent = msg.content;
              const grafanaLinks = extractGrafanaLinks(textContent);

              setParsedResponses((prev) => [
                ...prev,
                {
                  type: "user_message",
                  content: textContent,
                  displayedContent: textContent,
                  isAnimating: false,
                  timestamp: Date.now(),
                  grafanaLinks:
                    grafanaLinks.length > 0 ? grafanaLinks : undefined,
                },
              ]);
            }

            // For debugging and streaming format processing, accumulate content
            if (msg.content) {
              fullResponse += msg.content + "\n";
            }
          });

          // Set the raw response for debug view
          setResponse(fullResponse);

          // Now process streaming format messages for AI responses
          const lines = fullResponse.split("\n").filter((line) => line.trim());
          lines.forEach((line) => {
            try {
              const json = JSON.parse(line);

              // Use the same logic as the streaming handler
              if (json.type === "assistant" && json.message?.content) {
                json.message.content.forEach((item: any) => {
                  if (item.type === "text") {
                    const textContent = item.text;
                    const grafanaLinks = extractGrafanaLinks(textContent);

                    setParsedResponses((prev) => [
                      ...prev,
                      {
                        type: "text",
                        content: textContent,
                        displayedContent: textContent,
                        isAnimating: false,
                        timestamp: Date.now(),
                        grafanaLinks:
                          grafanaLinks.length > 0 ? grafanaLinks : undefined,
                      },
                    ]);
                  } else if (item.type === "tool_use") {
                    // Handle tool usage
                    setParsedResponses((prev) => [
                      ...prev,
                      {
                        type: "tool_use",
                        content: "",
                        toolName: item.name,
                        toolInput: item.input,
                        toolResult: "", // Will be filled by tool_result
                        timestamp: Date.now(),
                        isAnimating: false,
                        toolUseId: item.id,
                      },
                    ]);
                  }
                });
              } else if (json.type === "user" && json.message?.content) {
                // Handle user messages and tool results
                json.message.content.forEach((item: any) => {
                  if (item.type === "text") {
                    const textContent = item.text;
                    const grafanaLinks = extractGrafanaLinks(textContent);

                    setParsedResponses((prev) => [
                      ...prev,
                      {
                        type: "user_message",
                        content: textContent,
                        displayedContent: textContent,
                        isAnimating: false,
                        timestamp: Date.now(),
                        grafanaLinks:
                          grafanaLinks.length > 0 ? grafanaLinks : undefined,
                      },
                    ]);
                  } else if (item.type === "tool_result" && item.tool_use_id) {
                    // Handle tool results - update the corresponding tool use
                    setParsedResponses((prev) => {
                      const updated = [...prev];
                      const toolUseIndex = updated.findIndex(
                        (response) =>
                          response.type === "tool_use" &&
                          response.toolUseId === item.tool_use_id
                      );

                      if (toolUseIndex !== -1) {
                        // Extract tool result content
                        let toolResult = "";
                        if (item.content && Array.isArray(item.content)) {
                          toolResult = item.content
                            .map((c: any) => c.text || c)
                            .join("");
                        } else if (typeof item.content === "string") {
                          toolResult = item.content;
                        }

                        updated[toolUseIndex] = {
                          ...updated[toolUseIndex],
                          toolResult: toolResult,
                        };
                      }
                      return updated;
                    });
                  }
                });
              }
            } catch (e) {
              // Skip invalid JSON lines
            }
          });
        }

        setSelectedSession(sessionId);
        // Don't override the response we set above for the debug view
      } else {
        console.error("Failed to load chat session");
        setError("Failed to load chat session");
      }
    } catch (error) {
      console.error("Error loading chat session:", error);
      setError("Error loading chat session");
    } finally {
      setIsSessionLoading(false);
    }
  };

  // Start a new chat
  const startNewChat = () => {
    cancelRequest();
    setQuery("");
    setResponse("");
    setParsedResponses([]);
    setSelectedSession(null);
    setError("");
    setTotalTokens(0);
    setCompletedTokens(0);
    setElapsedTime(0);
    setCompletedTime(0);
    setIsSessionLoading(false);
    hasFetchedTitleRef.current = false;
  };

  const animateTitleTyping = (sessionId: string, title: string) => {
    const totalDuration = 2000;
    const steps = title.length;
    if (steps === 0) return;
    let index = 0;
    const interval = setInterval(() => {
      index += 1;
      setChatHistory((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId
            ? { ...s, displayedTitle: title.slice(0, index) }
            : s
        )
      );
      if (index >= steps) {
        clearInterval(interval);
        setChatHistory((prev) =>
          prev.map((s) =>
            s.sessionId === sessionId ? { ...s, displayedTitle: undefined } : s
          )
        );
      }
    }, totalDuration / steps);
  };

  // Fetch chat history on mount
  useEffect(() => {
    if (session.data?.user) {
      fetchChatHistory(true);
    }
  }, [session.data?.user]);

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
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
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
            if (!hasFetchedTitleRef.current && parsedResponses.length === 0) {
              hasFetchedTitleRef.current = true;
              fetchChatHistory().then(() => {
                const latest = chatHistoryRef.current[0];
                if (latest && latest.title) {
                  animateTitleTyping(latest.sessionId, latest.title);
                  setSelectedSession(latest.sessionId);
                }
              });
            }
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

    const placeholderId = `tmp-${Date.now()}`;
    const nowIso = new Date().toISOString();
    const placeholderSession: ChatSession = {
      sessionId: placeholderId,
      timestamp: nowIso,
      date: nowIso.slice(0, 10).replace(/-/g, ""),
      filename: "",
      key: placeholderId,
      status: "in_progress",
    };
    setChatHistory((prev) => [placeholderSession, ...prev]);
    setSelectedSession(placeholderId);
    hasFetchedTitleRef.current = false;

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
      const response = await fetch("/api/torchagent-api", {
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
            fetchChatHistory();
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
      fetchChatHistory();
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
              {item.type === "user_message" ? (
                <Box
                  sx={{
                    mb: 3,
                    p: 2,
                    backgroundColor: "action.hover",
                    borderRadius: 1,
                    borderLeft: "4px solid",
                    borderLeftColor: "primary.main",
                  }}
                >
                  <Typography
                    variant="subtitle2"
                    color="primary"
                    sx={{ mb: 1 }}
                  >
                    User Query:
                  </Typography>
                  <Typography variant="body1">
                    {renderTextWithLinks(item.content, false)}
                  </Typography>

                  {item.grafanaLinks && item.grafanaLinks.length > 0 && (
                    <Box mt={2}>
                      {item.grafanaLinks.map((link, i) => (
                        <GrafanaEmbed key={i} dashboardId={link.dashboardId} />
                      ))}
                    </Box>
                  )}
                </Box>
              ) : item.type === "text" ? (
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
                      {/* For historical chats, we skip timing calculations since timestamps are strings */}
                      {item.outputTokens
                        ? `${formatTokenCount(item.outputTokens)} tokens`
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
                  timestamp={
                    typeof item.timestamp === "number"
                      ? item.timestamp
                      : undefined
                  }
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

  const sidebarWidth = 300;

  return (
    <Box sx={{ display: "flex", height: "100vh" }}>
      {/* Sidebar */}
      <ChatHistorySidebar
        drawerOpen={drawerOpen}
        sidebarWidth={sidebarWidth}
        chatHistory={chatHistory}
        selectedSession={selectedSession}
        isHistoryLoading={isHistoryLoading}
        onStartNewChat={startNewChat}
        onLoadChatSession={loadChatSession}
      />

      {/* Main Content */}
      <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
        {isSessionLoading ? (
          <LoadingDisplay message="Loading Conversation..." showFullScreen />
        ) : (
          <TorchAgentPageContainer>
            <HeaderSection
              showScrollButton={showScrollButton}
              onScrollToBottom={scrollToBottomAndEnable}
              featureRequestUrl={featureRequestUrl}
              bugReportUrl={bugReportUrl}
            />

            {/* Show welcome message and query input only for new chats */}
            {!selectedSession && (
              <WelcomeSection
                query={query}
                isLoading={isLoading}
                debugVisible={debugVisible}
                onQueryChange={handleQueryChange}
                onSubmit={handleSubmit}
                onToggleDebug={() => setDebugVisible(!debugVisible)}
                onCancel={cancelRequest}
              />
            )}

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
                      {allToolsExpanded
                        ? "Collapse all tools"
                        : "Expand all tools"}
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
                  <Typography variant="subtitle2">
                    Debug: Raw Response
                  </Typography>
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
                      color:
                        theme.palette.mode === "dark" ? "#e0e0e0" : "#333333",
                    }}
                  >
                    {response || "(No data yet)"}
                  </pre>
                </Box>
              )}
            </ResultsSection>

            <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 2 }}>
              <Button
                variant="outlined"
                component="a"
                href={featureRequestUrl}
                target="_blank"
                sx={{ mr: 1 }}
              >
                Feature Request
              </Button>
              <Button
                variant="outlined"
                color="error"
                component="a"
                href={bugReportUrl}
                target="_blank"
              >
                Report Bug
              </Button>
            </Box>
          </TorchAgentPageContainer>
        )}
      </Box>
    </Box>
  );
};
