import MenuIcon from "@mui/icons-material/Menu";
import {
  Box,
  Button,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  processContentBlockDelta,
  processMessageLine,
} from "./TorchAgentPage/messageProcessor";
import { QueryInputSection } from "./TorchAgentPage/QueryInputSection";
import {
  ChatMain,
  ChatMessages,
  ChunkMetadata,
  LoaderWrapper,
  MessageBubble,
  QuerySection,
  ResponseText,
  TorchAgentPageContainer,
} from "./TorchAgentPage/styles";
import { TodoList } from "./TorchAgentPage/TodoList";
import { ToolUse } from "./TorchAgentPage/ToolUse";
import { ParsedContent } from "./TorchAgentPage/types";
import {
  extractGrafanaLinks,
  formatElapsedTime,
  formatTokenCount,
  renderMarkdownWithLinks,
} from "./TorchAgentPage/utils";
import { WelcomeSection } from "./TorchAgentPage/WelcomeSection";

interface ChatSession {
  sessionId: string;
  timestamp: string;
  date: string;
  filename: string;
  key: string;
  title?: string;
  status?: string;
}

// Helper function to check for special auth cookie (presence only)
const hasAuthCookie = () => {
  if (typeof document === "undefined") return false;

  const cookies = document.cookie.split(";");
  const authCookie = cookies.find((cookie) =>
    cookie.trim().startsWith("GRAFANA_MCP_AUTH_TOKEN=")
  );

  return !!authCookie;
};

export const TorchAgentPage = () => {
  const session = useSession();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("lg")); // Below 1200px

  // Constants
  const typingSpeed = 3; // ms per character
  const sidebarWidth = 300;

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
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [completedTokens, setCompletedTokens] = useState(0);
  const [completedTime, setCompletedTime] = useState(0);
  const [error, setError] = useState("");
  const [debugVisible, setDebugVisible] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [headerHeight, setHeaderHeight] = useState(80); // Default fallback

  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-collapse sidebar on mobile screens
  useEffect(() => {
    if (isMobile && drawerOpen) {
      setDrawerOpen(false);
    } else if (!isMobile && !drawerOpen) {
      setDrawerOpen(true);
    }
    // Don't auto-expand on desktop - preserve user preference
  }, [isMobile]);

  // Measure header height dynamically by calculating offset from viewport top
  useEffect(() => {
    const measureHeaderHeight = () => {
      if (contentRef.current) {
        const rect = contentRef.current.getBoundingClientRect();
        const height = Math.max(rect.top, 80); // Ensure minimum of 80px
        setHeaderHeight(height);
      }
    };

    // Use requestAnimationFrame for proper timing after render
    const rafId = requestAnimationFrame(measureHeaderHeight);

    // Re-measure on window resize
    const handleResize = () => {
      requestAnimationFrame(measureHeaderHeight);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const toggleSidebar = () => {
    setDrawerOpen(!drawerOpen);
  };

  const fetchControllerRef = useRef<AbortController | null>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

  const thinkingMessages = useThinkingMessages();
  const displayedTokens = useAnimatedCounter(totalTokens);
  const calculateTotalTokens = useTokenCalculator();
  const { showScrollButton, scrollToBottomAndEnable, resetAutoScroll } =
    useAutoScroll(isLoading, parsedResponses, chatContainerRef);

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  const renderLoader = () => (
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

  const fetchChatHistory = useCallback(async () => {
    if (!session.data?.user && !hasAuthCookie()) return;

    setIsHistoryLoading(true);
    try {
      const response = await fetch("/api/torchagent-get-history");
      if (response.ok) {
        const data = await response.json();
        setChatHistory(data.sessions || []);
      } else {
        console.error("Failed to fetch chat history");
      }
    } catch (error) {
      console.error("Error fetching chat history:", error);
    } finally {
      setIsHistoryLoading(false);
    }
  }, [session.data?.user]);

  const loadChatSession = async (sessionId: string) => {
    // Cancel any active stream first
    if (fetchControllerRef.current && isLoading) {
      console.log("Cancelling active stream to load historic chat");
      fetchControllerRef.current.abort();
      fetchControllerRef.current = null;
      setIsLoading(false);
    }

    setIsSessionLoading(true);
    setParsedResponses([]);
    setResponse("");
    setError("");

    // Close mobile sidebar when loading a session
    if (isMobile && drawerOpen) {
      setDrawerOpen(false);
    }

    try {
      const response = await fetch(
        `/api/torchagent-get-chat-history?sessionId=${sessionId}`
      );
      if (response.ok) {
        const sessionData = await response.json();

        if (sessionData.messages && Array.isArray(sessionData.messages)) {
          setParsedResponses([]);

          let fullResponse = "";
          sessionData.messages.forEach((msg: any) => {
            if (msg.content) {
              fullResponse += msg.content + "\n";
            }
          });
          setResponse(fullResponse);

          // Process all messages in chronological order
          sessionData.messages.forEach((msg: any) => {
            if (msg.type === "user_message" || msg.type === "user") {
              // Process user message
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
            } else if (msg.content) {
              // Process assistant message content line by line
              const lines = msg.content
                .split("\n")
                .filter((line: string) => line.trim());
              lines.forEach((line: string) => {
                processMessageLine(
                  line,
                  setParsedResponses,
                  false,
                  undefined,
                  (sessionId: string) => {
                    console.log(
                      "Setting session ID from loadChatSession:",
                      sessionId
                    );
                    setCurrentSessionId(sessionId);
                  }
                );
              });
            }
          });
        }

        setSelectedSession(sessionId);
        setCurrentSessionId(sessionId);
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

  const startNewChat = () => {
    // Cancel any active stream first
    if (fetchControllerRef.current && isLoading) {
      console.log("Cancelling active stream to start new chat");
      fetchControllerRef.current.abort();
      fetchControllerRef.current = null;
      setIsLoading(false);
    }

    setQuery("");
    setResponse("");
    setParsedResponses([]);
    setSelectedSession(null);
    setCurrentSessionId(null);
    setError("");
    setTotalTokens(0);
    setCompletedTokens(0);
    setElapsedTime(0);
    setCompletedTime(0);
    setIsSessionLoading(false);

    // Close mobile sidebar when starting new chat
    if (isMobile && drawerOpen) {
      setDrawerOpen(false);
    }
  };

  useEffect(() => {
    if (session.data?.user) {
      fetchChatHistory();
    }
  }, [session.data?.user, fetchChatHistory]);

  useEffect(() => {
    if (!session.data?.user) return;

    let timeoutId: NodeJS.Timeout;

    const scheduleNextUpdate = () => {
      // Only refresh history if there's an actual active streaming chat or in_progress sessions
      const hasActiveChat =
        isLoading || // Currently streaming a response
        // OR there's a current session that's in progress (user sent message, waiting for response)
        (currentSessionId &&
          chatHistory.some(
            (chat) =>
              chat.sessionId === currentSessionId &&
              chat.status === "in_progress"
          )) ||
        // OR there are other sessions marked as in_progress or temporary "New Chat..." entries
        chatHistory.some(
          (chat) =>
            chat.title === "New Chat..." ||
            (chat.status && chat.status === "in_progress")
        );

      if (hasActiveChat) {
        timeoutId = setTimeout(async () => {
          await fetchChatHistory();
          scheduleNextUpdate(); // Schedule the next check
        }, 10000);
      }
    };

    // Start the first check
    scheduleNextUpdate();

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [session.data?.user, isLoading, currentSessionId, fetchChatHistory]);

  useEffect(() => {
    if (!isLoading) return;

    const interval = setInterval(() => {
      setThinkingMessageIndex((prev) => (prev + 1) % thinkingMessages.length);
    }, 6000);

    return () => clearInterval(interval);
  }, [isLoading, thinkingMessages.length]);

  useEffect(() => {
    if (isLoading && parsedResponses.length > 0) {
      setThinkingMessageIndex((prev) => (prev + 1) % thinkingMessages.length);
    }
  }, [parsedResponses.length, isLoading, thinkingMessages.length]);

  useEffect(() => {
    if (!isLoading || !startTime) return;

    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      setElapsedTime(elapsed);
    }, 1000);

    return () => clearInterval(timer);
  }, [isLoading, startTime]);

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

  useEffect(() => {
    if (parsedResponses.length > 0) {
      const total = calculateTotalTokens(parsedResponses);
      if (isFinite(total) && total >= 0 && total !== totalTokens) {
        setTotalTokens(total);
      }
    }
  }, [parsedResponses, calculateTotalTokens, totalTokens]);

  useEffect(() => {
    return () => {
      if (fetchControllerRef.current) {
        fetchControllerRef.current.abort();
        fetchControllerRef.current = null;
      }
    };
  }, []);

  const parseJsonLine = (line: string) => {
    try {
      if (!line.trim()) return;

      setResponse((prev) => prev + line + "\n");
      const json = JSON.parse(line) as any;

      if (json.status === "connecting" && json.sessionId) {
        setCurrentSessionId(json.sessionId);

        // Only add to chat history if this is a new session (not resuming)
        if (!json.resumeSession) {
          const now = new Date();
          const timestamp = now.toISOString();
          const tempSession: ChatSession = {
            sessionId: json.sessionId,
            timestamp: timestamp,
            date: timestamp.slice(0, 10),
            filename: `${timestamp}_${json.sessionId}.json`,
            key: `history/user/${timestamp}_${json.sessionId}.json`,
            title: "New Chat...",
          };

          setChatHistory((prev) => [tempSession, ...prev]);
          setSelectedSession(json.sessionId);
        }
        // For resumed sessions, we keep the existing selectedSession and just update currentSessionId
        return;
      }

      // Handle system messages with session_id
      if (json.type === "agent_mgmt" && json.sessionId) {
        console.log("Received session_id from system message:", json.sessionId);
        setCurrentSessionId(json.sessionId);
        return;
      }

      if (
        json.type === "result" &&
        json.subtype === "success" &&
        json.duration_ms
      ) {
        const durationSec = Math.round(json.duration_ms / 1000);
        setElapsedTime(durationSec);
      }

      if (json.type === "assistant" || json.type === "user") {
        processMessageLine(
          "",
          setParsedResponses,
          true,
          json,
          (sessionId: string) => {
            console.log(
              "Setting session ID from processMessageLine:",
              sessionId
            );
            setCurrentSessionId(sessionId);
          }
        );
      } else if (json.type === "content_block_delta") {
        processContentBlockDelta(json, setParsedResponses);
      } else if (json.error) {
        setError(`Error: ${json.error}`);
      }
    } catch (err) {
      console.error("Failed to parse:", line);
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

    // Add user query to parsed responses immediately and clear input
    const userMessage = {
      type: "user_message" as const,
      content: query,
      timestamp: Date.now(),
    };

    setIsLoading(true);
    setResponse("");

    // For new chats or when no session exists, start fresh
    // For continued sessions, append to existing responses
    if (!currentSessionId || !selectedSession) {
      setParsedResponses([userMessage]); // Start fresh for new chats
    } else {
      setParsedResponses((prev) => [...prev, userMessage]); // Append for continued chats
    }

    setQuery(""); // Clear the input immediately
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
      const requestBody: any = { query: userMessage.content };

      // Include sessionId if this is a continued session
      if (currentSessionId) {
        console.log("Continuing session with sessionId:", currentSessionId);
        requestBody.sessionId = currentSessionId;
      } else {
        console.log("Starting new session");
      }

      console.log("Sending request body:", requestBody);

      const response = await fetch("/api/torchagent-api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(requestBody),
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

          const finalTokens = calculateTotalTokens(parsedResponses);
          setCompletedTime(elapsedTime);
          setCompletedTokens(finalTokens);
          setTotalTokens(finalTokens);
          setIsLoading(false);

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

  const hasCookieAuth = hasAuthCookie();

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
    !hasCookieAuth &&
    (session.status === "unauthenticated" ||
      !session.data?.user ||
      !(session.data as any)?.accessToken)
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
        return renderLoader();
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
              {" "}
              {item.type === "user_message" ? (
                <>
                  <MessageBubble from="user">
                    {renderMarkdownWithLinks(
                      item.content,
                      false,
                      theme.palette.mode === "dark"
                    )}
                  </MessageBubble>
                  {item.grafanaLinks && item.grafanaLinks.length > 0 && (
                    <MessageBubble from="user" fullWidth>
                      {item.grafanaLinks.map((link, i) => (
                        <GrafanaEmbed key={i} dashboardId={link.dashboardId} />
                      ))}
                    </MessageBubble>
                  )}
                </>
              ) : item.type === "text" ? (
                <>
                  <MessageBubble from="agent">
                    <ResponseText>
                      {renderMarkdownWithLinks(
                        (item.displayedContent !== undefined
                          ? item.displayedContent
                          : item.content
                        )?.trim() || "",
                        item.isAnimating,
                        theme.palette.mode === "dark"
                      )}
                    </ResponseText>
                    {!item.isAnimating && (
                      <ChunkMetadata>
                        {item.outputTokens
                          ? `${formatTokenCount(item.outputTokens)} tokens`
                          : ""}
                      </ChunkMetadata>
                    )}
                  </MessageBubble>
                  {item.grafanaLinks && item.grafanaLinks.length > 0 && (
                    <MessageBubble from="agent" fullWidth>
                      {item.grafanaLinks.map((link, i) => (
                        <GrafanaEmbed key={i} dashboardId={link.dashboardId} />
                      ))}
                    </MessageBubble>
                  )}
                </>
              ) : item.type === "tool_use" &&
                item.toolName &&
                item.toolName !== "TodoWrite" &&
                item.toolName !== "TodoRead" ? (
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

        {isLoading && renderLoader()}

        {completedTokens > 0 && !isLoading && (
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
        )}
      </div>
    );
  };

  return (
    <Box sx={{ display: "flex", height: "100vh" }}>
      {/* Hamburger button for collapsed sidebar */}
      {!drawerOpen && (
        <Box
          sx={{
            position: "fixed",
            top: `${headerHeight + 16}px`, // Dynamic position based on header height + some padding
            left: "16px",
            zIndex: 1300,
            backgroundColor: "background.paper",
            borderRadius: "50%",
            boxShadow: 2,
          }}
        >
          <Tooltip title="Open sidebar">
            <IconButton
              onClick={toggleSidebar}
              aria-label="Open sidebar"
              size="large"
            >
              <MenuIcon />
            </IconButton>
          </Tooltip>
        </Box>
      )}

      <ChatHistorySidebar
        drawerOpen={drawerOpen}
        sidebarWidth={sidebarWidth}
        chatHistory={chatHistory}
        selectedSession={selectedSession}
        isHistoryLoading={isHistoryLoading}
        isMobile={isMobile}
        headerHeight={headerHeight}
        onStartNewChat={startNewChat}
        onLoadChatSession={loadChatSession}
        onToggleSidebar={toggleSidebar}
      />

      <ChatMain
        sx={{
          marginLeft: drawerOpen && !isMobile ? `${sidebarWidth}px` : 0,
          transition: "margin-left 0.3s ease",
        }}
      >
        {isSessionLoading ? (
          <LoadingDisplay
            message="Loading Conversation..."
            showFullScreen
            drawerOpen={drawerOpen && !isMobile}
            sidebarWidth={sidebarWidth}
          />
        ) : (
          <TorchAgentPageContainer
            ref={contentRef}
            drawerOpen={drawerOpen && !isMobile}
            sidebarWidth={sidebarWidth}
          >
            <HeaderSection
              showScrollButton={showScrollButton}
              onScrollToBottom={scrollToBottomAndEnable}
              featureRequestUrl={featureRequestUrl}
              bugReportUrl={bugReportUrl}
            />

            <ChatMessages ref={chatContainerRef}>
              {parsedResponses.length > 0 && (
                <>
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
                      parsedResponses.some(
                        (item) => item.type === "tool_use"
                      ) && (
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
                                  if (
                                    parsedResponses[index].type === "tool_use"
                                  ) {
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
                            theme.palette.mode === "dark"
                              ? "#121212"
                              : "#f0f0f0",
                          padding: "8px",
                          borderRadius: "4px",
                          color:
                            theme.palette.mode === "dark"
                              ? "#e0e0e0"
                              : "#333333",
                        }}
                      >
                        {response || "(No data yet)"}
                      </pre>
                    </Box>
                  )}
                </>
              )}
            </ChatMessages>

            {/* Show welcome message for completely new chats */}
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

            {/* Show query input for active chats (read-only for history) */}
            {selectedSession && (
              <QueryInputSection
                query={query}
                isLoading={isLoading}
                debugVisible={debugVisible}
                onQueryChange={handleQueryChange}
                onSubmit={handleSubmit}
                onToggleDebug={() => setDebugVisible(!debugVisible)}
                onCancel={cancelRequest}
                currentSessionId={currentSessionId}
              />
            )}
          </TorchAgentPageContainer>
        )}
      </ChatMain>
    </Box>
  );
};
