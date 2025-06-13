import React from "react";
import { GrafanaLink } from "./types";

const GRAFANA_LINK_REGEX = /https?:\/\/pytorchci\.grafana\.net\/?\/?public-dashboards\/([a-zA-Z0-9]+)/g;

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

export const renderTextWithLinks = (
  text: string,
  isAnimating?: boolean
): React.ReactNode => {
  if (!text) return null;

  const result: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let counter = 0;

  // Reset regex lastIndex to avoid issues with global regex
  GRAFANA_LINK_REGEX.lastIndex = 0;
  
  while ((match = GRAFANA_LINK_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(text.substring(lastIndex, match.index));
    }

    result.push(
      <a
        key={counter++}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "#1976d2", textDecoration: "underline" }}
      >
        {match[0]}
      </a>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push(text.substring(lastIndex));
  }

  if (text.length > 0 && result.length > 0 && isAnimating) {
    const lastItem = result[result.length - 1];

    if (typeof lastItem === "string") {
      result[result.length - 1] = (
        <>
          {lastItem}
          <span
            style={{
              borderRight: "2px solid currentColor",
              marginLeft: "2px",
              animation: "blink 1s step-end infinite",
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
        </>
      );
    }
  }

  return result;
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