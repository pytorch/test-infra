import { ParsedContent } from "./types";
import { extractGrafanaLinks } from "./utils";

// Process a single message line (either from streaming or history)
export const processMessageLine = (
  line: string,
  setParsedResponses: React.Dispatch<React.SetStateAction<ParsedContent[]>>,
  isStreaming: boolean = false,
  json?: any,
  onSessionIdReceived?: (sessionId: string) => void
): void => {
  try {
    // If json is not provided, parse the line
    if (!json) {
      json = JSON.parse(line);
    }

    // Handle system messages with session_id
    if (json.type === "system" && json.subtype === "init" && json.session_id) {
      console.log("Received session_id from system message:", json.session_id);
      if (onSessionIdReceived) {
        onSessionIdReceived(json.session_id);
      }
      return;
    }

    // Handle assistant messages
    if (json.type === "assistant" && json.message?.content) {
      json.message.content.forEach((item: any) => {
        if (item.type === "text") {
          const textContent = item.text || "";
          const grafanaLinks = extractGrafanaLinks(textContent);

          setParsedResponses((prev) => [
            ...prev,
            {
              type: "text",
              content: textContent,
              displayedContent: isStreaming ? "" : textContent,
              isAnimating: isStreaming,
              grafanaLinks: grafanaLinks.length > 0 ? grafanaLinks : undefined,
              timestamp: Date.now(),
              outputTokens: json.message?.usage?.output_tokens || 0,
            },
          ]);
        } else if (item.type === "tool_use") {
          // Special handling for Todo tools in streaming mode
          if (
            isStreaming &&
            (item.name === "TodoWrite" || item.name === "TodoRead")
          ) {
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
                  outputTokens: 0,
                  toolUseId: item.id,
                });

                return updated;
              });
            } else {
              setParsedResponses((prev) => [
                ...prev,
                {
                  type: "tool_use",
                  content: "",
                  toolName: item.name,
                  toolInput: item.input,
                  timestamp: Date.now(),
                  outputTokens: 0,
                  toolUseId: item.id,
                },
              ]);
            }
          } else {
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
        }
      });
    }
    // Handle user messages and tool results
    else if (json.type === "user" && json.message?.content) {
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
              grafanaLinks: grafanaLinks.length > 0 ? grafanaLinks : undefined,
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
              const toolName = updated[toolUseIndex].toolName;

              // Special handling for Todo tools in streaming mode
              if (
                isStreaming &&
                (toolName === "TodoWrite" || toolName === "TodoRead")
              ) {
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
                    toolResult: item.content?.[0]?.text || "No result content",
                  };
                }
              } else {
                // Regular tool result handling
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
            }
            return updated;
          });
        }
      });
    }
  } catch (e) {
    // Skip invalid JSON lines
    console.warn("Failed to parse message line:", line);
  }
};

// Process user messages from session data (for history loading)
export const processUserMessages = (
  messages: any[],
  setParsedResponses: React.Dispatch<React.SetStateAction<ParsedContent[]>>
): void => {
  messages.forEach((msg: any) => {
    // Handle both "user_message" and "user" type messages
    if ((msg.type === "user_message" || msg.type === "user") && msg.content) {
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
          grafanaLinks: grafanaLinks.length > 0 ? grafanaLinks : undefined,
        },
      ]);
    }
  });
};

// Handle content block deltas (streaming only)
export const processContentBlockDelta = (
  json: any,
  setParsedResponses: React.Dispatch<React.SetStateAction<ParsedContent[]>>
): void => {
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
        const currentTokens = updated[updated.length - 1].outputTokens || 0;
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
};
