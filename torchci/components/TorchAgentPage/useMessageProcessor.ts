import { useState, useCallback } from "react";
import { extractGrafanaLinks } from "./utils";
import { processMessageLine } from "./messageProcessor";
import { ParsedContent } from "./types";

export const useMessageProcessor = () => {
  const [parsedResponses, setParsedResponses] = useState<ParsedContent[]>([]);
  const [response, setResponse] = useState("");

  const processSessionData = useCallback((sessionData: any, setCurrentSessionId?: (id: string) => void) => {
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
              grafanaLinks: grafanaLinks.length > 0 ? grafanaLinks : undefined,
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
              setCurrentSessionId || (() => {})
            );
          });
        }
      });
    }
  }, []);

  const clearMessages = useCallback(() => {
    setParsedResponses([]);
    setResponse("");
  }, []);

  return {
    parsedResponses,
    response,
    setParsedResponses,
    setResponse,
    processSessionData,
    clearMessages,
  };
};