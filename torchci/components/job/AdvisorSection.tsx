import { AdvisorVerdict, advisorRunUrl } from "lib/advisorVerdictUtils";
import { useState } from "react";

const VERDICT_COLORS: Record<string, { border: string; badge: string }> = {
  revert: { border: "#d32f2f", badge: "#d32f2f" },
  not_related: { border: "#388e3c", badge: "#2e7d32" },
  garbage: { border: "#8d6e63", badge: "#6d4c41" },
  unsure: { border: "#757575", badge: "#616161" },
};

export default function AdvisorSection({
  verdict,
  repoOwner,
  repoName,
}: {
  verdict: AdvisorVerdict;
  repoOwner?: string;
  repoName?: string;
}) {
  const [showReasoning, setShowReasoning] = useState(false);
  const colors = VERDICT_COLORS[verdict.verdict] ?? VERDICT_COLORS.unsure;

  return (
    <div
      style={{
        marginTop: 4,
        padding: "4px 8px",
        borderRadius: 4,
        borderLeft: `3px solid ${colors.border}`,
        background: "rgba(128,128,128,0.15)",
        fontSize: "0.9em",
        maxWidth: 500,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            display: "inline-block",
            padding: "1px 5px",
            borderRadius: 3,
            fontSize: "0.85em",
            fontWeight: 700,
            background: colors.badge,
            color: "#fff",
          }}
        >
          AI: {verdict.verdict}
        </span>
        <span
          style={{
            fontSize: "0.85em",
            fontWeight: 600,
            opacity: 0.7,
          }}
        >
          {Math.round(verdict.confidence * 100)}% confidence
        </span>
      </div>
      <div
        style={{
          marginTop: 3,
          wordBreak: "break-word",
          overflowWrap: "break-word",
          whiteSpace: "normal",
        }}
      >
        {verdict.summary}
      </div>
      {verdict.causalReasoning && (
        <div style={{ marginTop: 3 }}>
          <span
            onClick={() => setShowReasoning(!showReasoning)}
            style={{
              cursor: "pointer",
              fontSize: "0.85em",
              color: "var(--link-color, #1a73e8)",
              userSelect: "none",
            }}
          >
            {showReasoning ? "▼" : "▶"} Reasoning
          </span>
          {showReasoning && (
            <div
              style={{
                marginTop: 3,
                padding: "4px 6px",
                background: "rgba(128,128,128,0.12)",
                borderRadius: 3,
                fontSize: "0.85em",
                wordBreak: "break-word",
                overflowWrap: "break-word",
                whiteSpace: "pre-wrap",
                maxHeight: 300,
                overflowY: "auto",
              }}
            >
              {verdict.causalReasoning}
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 3 }}>
        <a
          href={advisorRunUrl(verdict, `${repoOwner}/${repoName}`)}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: "0.85em",
            color: "var(--link-color, #1a73e8)",
          }}
        >
          View advisor run →
        </a>
      </div>
    </div>
  );
}
