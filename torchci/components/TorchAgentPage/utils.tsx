import React from "react";
import ReactMarkdown from "react-markdown";
import { GrafanaLink } from "./types";

const GRAFANA_LINK_REGEX =
  /https?:\/\/pytorchci\.grafana\.net\/?\/?public-dashboards\/([a-zA-Z0-9]+)/g;

export const extractGrafanaLinks = (text: string): GrafanaLink[] => {
  const links: GrafanaLink[] = [];
  let match;

  while ((match = GRAFANA_LINK_REGEX.exec(text)) !== null) {
    links.push({
      fullUrl: match[0],
      dashboardId: match[1],
    });
  }

  return links;
};

const convertPlainUrlsToMarkdown = (text: string): string => {
  // Simple and reliable URL regex: https?:// followed by any non-whitespace characters
  const urlRegex = /https?:\/\/\S+/gi;

  // Create a copy to work with
  let result = text;
  let processedUrls = new Set<string>();

  // Find all URLs and process them
  let match;
  const matches = [];

  // Reset regex
  urlRegex.lastIndex = 0;

  while ((match = urlRegex.exec(text)) !== null) {
    matches.push({
      url: match[0],
      index: match.index,
      length: match[0].length,
    });
  }

  // Process matches in reverse order to avoid index shifting
  for (let i = matches.length - 1; i >= 0; i--) {
    const { url, index } = matches[i];

    // Skip if we've already processed this exact URL
    if (processedUrls.has(url)) continue;
    processedUrls.add(url);

    // Get context around the URL
    const beforeUrl = text.substring(Math.max(0, index - 2), index);
    const afterUrl = text.substring(index + url.length, index + url.length + 1);

    // Check if it's already in markdown link format
    if (beforeUrl.endsWith("](") || afterUrl.startsWith(")")) {
      continue;
    }

    // Check if it's in an existing markdown link by looking for bracket patterns
    const textBeforeUrl = text.substring(0, index);
    const lastOpenBracket = textBeforeUrl.lastIndexOf("[");
    const lastCloseBracket = textBeforeUrl.lastIndexOf("](");

    // If we found '](' after the last '[' and close to this URL, skip it
    if (lastCloseBracket > lastOpenBracket && index - lastCloseBracket < 20) {
      continue;
    }

    // Replace this specific occurrence in the result string
    const beforeReplace = result.substring(0, index);
    const afterReplace = result.substring(index + url.length);
    result = beforeReplace + `[${url}](${url})` + afterReplace;

    // Adjust indices for remaining matches
    const lengthDiff = `[${url}](${url})`.length - url.length;
    for (let j = 0; j < i; j++) {
      if (matches[j].index > index) {
        matches[j].index += lengthDiff;
      }
    }
  }

  return result;
};

export const renderMarkdownWithLinks = (
  text: string,
  isAnimating?: boolean,
  isDarkMode?: boolean
): React.ReactNode => {
  if (!text) return null;

  // Convert plain URLs to markdown links if they're not already markdown links
  const processedText = convertPlainUrlsToMarkdown(text);

  const codeBlockBg = isDarkMode
    ? "rgba(255, 255, 255, 0.1)"
    : "rgba(0, 0, 0, 0.05)";
  const inlineCodeBg = isDarkMode
    ? "rgba(255, 255, 255, 0.15)"
    : "rgba(0, 0, 0, 0.1)";
  const blockquoteBorder = isDarkMode ? "#666" : "#ccc";
  const blockquoteColor = isDarkMode
    ? "rgba(255, 255, 255, 0.7)"
    : "rgba(0, 0, 0, 0.7)";

  const markdownElement = (
    <ReactMarkdown
      components={{
        // Custom link component to handle Grafana links and other links
        a: ({ href, children, ...props }) => (
          <a
            {...props}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "#1976d2",
              textDecoration: "underline",
              wordBreak: "break-word",
            }}
          >
            {children}
          </a>
        ),
        // Custom code block styling
        code: ({ children, className, ...props }) => {
          const isBlock = className?.includes("language-");
          return (
            <code
              {...props}
              style={{
                backgroundColor: isBlock ? codeBlockBg : inlineCodeBg,
                padding: isBlock ? "12px" : "2px 4px",
                borderRadius: "4px",
                fontFamily: "monospace",
                fontSize: isBlock ? "0.9em" : "0.85em",
                display: isBlock ? "block" : "inline",
                whiteSpace: isBlock ? "pre-wrap" : "nowrap",
                overflowX: isBlock ? "auto" : "visible",
              }}
            >
              {children}
            </code>
          );
        },
        // Custom pre styling for code blocks
        pre: ({ children, ...props }) => (
          <pre
            {...props}
            style={{
              backgroundColor: codeBlockBg,
              padding: "12px",
              borderRadius: "4px",
              overflow: "auto",
              margin: "8px 0",
            }}
          >
            {children}
          </pre>
        ),
        // Custom paragraph styling
        p: ({ children, ...props }) => (
          <p {...props} style={{ margin: "8px 0", lineHeight: "1.6" }}>
            {children}
          </p>
        ),
        // Custom list styling
        ul: ({ children, ...props }) => (
          <ul {...props} style={{ paddingLeft: "20px", margin: "8px 0" }}>
            {children}
          </ul>
        ),
        ol: ({ children, ...props }) => (
          <ol {...props} style={{ paddingLeft: "20px", margin: "8px 0" }}>
            {children}
          </ol>
        ),
        // Custom heading styling
        h1: ({ children, ...props }) => (
          <h1
            {...props}
            style={{
              fontSize: "1.5em",
              fontWeight: "bold",
              margin: "16px 0 8px 0",
            }}
          >
            {children}
          </h1>
        ),
        h2: ({ children, ...props }) => (
          <h2
            {...props}
            style={{
              fontSize: "1.3em",
              fontWeight: "bold",
              margin: "14px 0 6px 0",
            }}
          >
            {children}
          </h2>
        ),
        h3: ({ children, ...props }) => (
          <h3
            {...props}
            style={{
              fontSize: "1.1em",
              fontWeight: "bold",
              margin: "12px 0 4px 0",
            }}
          >
            {children}
          </h3>
        ),
        // Custom blockquote styling
        blockquote: ({ children, ...props }) => (
          <blockquote
            {...props}
            style={{
              borderLeft: `4px solid ${blockquoteBorder}`,
              paddingLeft: "16px",
              margin: "8px 0",
              fontStyle: "italic",
              color: blockquoteColor,
            }}
          >
            {children}
          </blockquote>
        ),
        // Custom table styling
        table: ({ children, ...props }) => (
          <table
            {...props}
            style={{
              borderCollapse: "collapse",
              width: "100%",
              margin: "8px 0",
            }}
          >
            {children}
          </table>
        ),
        th: ({ children, ...props }) => {
          // Filter out react-markdown specific props that conflict with HTML props
          // eslint-disable-next-line unused-imports/no-unused-vars
          const { node, ...htmlProps } = props as any;
          return (
            <th
              {...htmlProps}
              style={{
                border: `1px solid ${blockquoteBorder}`,
                padding: "8px",
                backgroundColor: codeBlockBg,
                textAlign: "left",
                fontWeight: "bold",
              }}
            >
              {children}
            </th>
          );
        },
        td: ({ children, ...props }) => {
          // Filter out react-markdown specific props that conflict with HTML props
          // eslint-disable-next-line unused-imports/no-unused-vars
          const { node, ...htmlProps } = props as any;
          return (
            <td
              {...htmlProps}
              style={{
                border: `1px solid ${blockquoteBorder}`,
                padding: "8px",
              }}
            >
              {children}
            </td>
          );
        },
      }}
    >
      {processedText}
    </ReactMarkdown>
  );

  // Add animation cursor if needed
  if (isAnimating && text.length > 0) {
    return (
      <div style={{ position: "relative" }}>
        {markdownElement}
        <span
          style={{
            borderRight: "2px solid currentColor",
            marginLeft: "2px",
            animation: "blink 1s step-end infinite",
            position: "absolute",
            right: 0,
          }}
        />
        <style>
          {`
            @keyframes blink {
              0%, 100% { opacity: 1; }
              50% { opacity: 0; }
            }
          `}
        </style>
      </div>
    );
  }

  return markdownElement;
};

export const formatElapsedTime = (seconds: number): string => {
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

export const formatTokenCount = (count: number): string => {
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + "k";
  }
  return count.toString();
};

export const generateQueryId = (): string => {
  const hex = [];
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      hex[i] = "-";
    } else if (i === 14) {
      hex[i] = "4";
    } else {
      hex[i] = Math.floor(Math.random() * 16).toString(16);
    }
  }
  return hex.join("");
};

export const CLICKHOUSE_CONSOLE_BASE_URL =
  "https://console.clickhouse.cloud/services/c9b76950-2cf3-4fa0-93bb-94a65ff5f27d/console/query/";
