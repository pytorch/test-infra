import { Popover, Tooltip } from "@mui/material";
import AdvisorSection from "components/job/AdvisorSection";
import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { useState } from "react";
import styles from "./autorevert.module.css";
import {
  CellEvent,
  CellHighlight,
  ColumnAdvisorResult,
  ensureUtc,
  eventUrl,
} from "./types";

const STATUS_ICONS: Record<string, { icon: string; cls: string }> = {
  success: { icon: "✓", cls: styles.statusSuccess },
  failure: { icon: "✗", cls: styles.statusFailure },
  pending: { icon: "●", cls: styles.statusPending },
};

const STATUS_LABELS: Record<string, string> = {
  success: "Passed",
  failure: "Failed",
  pending: "Pending",
};

const HIGHLIGHT_LABELS: Record<string, string> = {
  suspected: "Suspected cause of failure",
  baseline: "Last known-good commit (baseline)",
  "newer-fail": "Also failing (after the suspect)",
  restart: "Targeted for CI restart",
};

const ADV_VERDICT_CLS: Record<string, string> = {
  revert: styles.advRevert,
  not_related: styles.advNotRelated,
  garbage: styles.advGarbage,
  unsure: styles.advUnsure,
};

const ADV_VERDICT_SHORT: Record<string, string> = {
  revert: "REV",
  not_related: "OK",
  garbage: "JNK",
  unsure: "?",
};

interface AutorevertCellProps {
  events: CellEvent[];
  highlight?: CellHighlight;
  advisorResult?: ColumnAdvisorResult;
  advisorDispatchPending?: boolean;
  fullAdvisorVerdict?: AdvisorVerdict;
  repo: string;
  isExpanded?: boolean;
  onExpandColumn?: () => void;
  // Context for the rich tooltip
  signalKey?: string;
  workflowName?: string;
  commitSha?: string;
}

function formatTime(isoTime: string): string {
  return new Date(ensureUtc(isoTime)).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export default function AutorevertCell({
  events,
  highlight,
  advisorResult,
  advisorDispatchPending,
  fullAdvisorVerdict,
  repo,
  isExpanded,
  onExpandColumn,
  signalKey,
  workflowName,
  commitSha,
}: AutorevertCellProps) {
  const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);

  const highlightClass = highlight
    ? {
        suspected: styles.cellSuspected,
        baseline: styles.cellBaseline,
        "newer-fail": styles.cellNewerFail,
        restart: styles.cellRestart,
      }[highlight]
    : "";

  const MAX_VISIBLE = 2;
  const showAll = isExpanded || events.length <= MAX_VISIBLE;
  const visibleEvents = showAll
    ? events
    : events.slice(events.length - MAX_VISIBLE);
  const hiddenCount = events.length - visibleEvents.length;

  // Build rich cell tooltip content
  const tooltipContent = (
    <div style={{ fontSize: "0.85rem", lineHeight: 1.6, maxWidth: 400 }}>
      {/* Signal + commit context */}
      {signalKey && (
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {workflowName}: {signalKey}
        </div>
      )}
      {highlight && (
        <div
          style={{
            fontSize: "0.8rem",
            opacity: 0.9,
            marginBottom: 6,
            fontStyle: "italic",
          }}
        >
          {HIGHLIGHT_LABELS[highlight] || highlight}
        </div>
      )}

      {/* Events list */}
      {events.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontWeight: 600, fontSize: "0.8rem", opacity: 0.7 }}>
            {events.length} CI run{events.length !== 1 ? "s" : ""} on this
            commit:
          </div>
          {events.map((ev, i) => {
            const url = eventUrl(repo, ev);
            return (
              <div
                key={i}
                style={{ marginLeft: 8, marginTop: 2, fontSize: "0.8rem" }}
              >
                <span className={STATUS_ICONS[ev.status]?.cls}>
                  {STATUS_ICONS[ev.status]?.icon}
                </span>{" "}
                {STATUS_LABELS[ev.status] || ev.status}
                {" — "}
                {formatTime(ev.started_at)}
                {ev.run_attempt && ev.run_attempt > 1
                  ? ` (attempt ${ev.run_attempt}, restarted by autorevert)`
                  : ""}
                {url && (
                  <>
                    {" "}
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#90caf9", fontSize: "0.75rem" }}
                    >
                      View logs →
                    </a>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {events.length === 0 && (
        <div
          style={{ fontSize: "0.8rem", opacity: 0.7, marginBottom: 4 }}
        >
          No CI runs recorded for this signal on this commit.
        </div>
      )}

      {/* Advisor verdict summary (inline, not the full popover) */}
      {fullAdvisorVerdict && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px solid rgba(255,255,255,0.1)",
            fontSize: "0.8rem",
          }}
        >
          <strong>AI Advisor:</strong> {fullAdvisorVerdict.verdict} (
          {Math.round(fullAdvisorVerdict.confidence * 100)}%)
          {fullAdvisorVerdict.summary && (
            <div style={{ opacity: 0.8, marginTop: 2 }}>
              {fullAdvisorVerdict.summary}
            </div>
          )}
          <div style={{ marginTop: 2 }}>
            <span
              style={{
                color: "#90caf9",
                cursor: "pointer",
                fontSize: "0.75rem",
              }}
            >
              Click AI badge for full analysis
            </span>
          </div>
        </div>
      )}
      {advisorResult && !fullAdvisorVerdict && (
        <div style={{ marginTop: 4, fontSize: "0.8rem" }}>
          <strong>AI Advisor:</strong> {advisorResult.verdict} (
          {Math.round(advisorResult.confidence * 100)}%)
        </div>
      )}
      {advisorDispatchPending && !advisorResult && !fullAdvisorVerdict && (
        <div style={{ marginTop: 4, fontSize: "0.8rem", opacity: 0.7 }}>
          AI advisor dispatched, awaiting result…
        </div>
      )}
    </div>
  );

  // Advisor badge
  let advisorBadge = null;
  if (fullAdvisorVerdict) {
    const cls =
      ADV_VERDICT_CLS[fullAdvisorVerdict.verdict] || styles.advUnsure;
    const short = ADV_VERDICT_SHORT[fullAdvisorVerdict.verdict] || "?";
    advisorBadge = (
      <span
        className={`${styles.advisorBadge} ${cls}`}
        onClick={(e) => {
          e.stopPropagation();
          setPopoverAnchor(e.currentTarget);
        }}
      >
        {short}
      </span>
    );
  } else if (advisorResult) {
    const cls = ADV_VERDICT_CLS[advisorResult.verdict] || styles.advUnsure;
    const short = ADV_VERDICT_SHORT[advisorResult.verdict] || "?";
    advisorBadge = <span className={`${styles.advisorBadge} ${cls}`}>{short}</span>;
  } else if (advisorDispatchPending) {
    advisorBadge = (
      <span className={`${styles.advisorBadge} ${styles.advPending}`}>…</span>
    );
  }

  if (events.length === 0 && !advisorBadge) {
    return <td className={`${styles.colSignal} ${highlightClass}`} />;
  }

  // Render event icons (clickable links, no individual tooltips)
  const eventIcons = visibleEvents.map((ev, i) => {
    const { icon, cls } = STATUS_ICONS[ev.status] || STATUS_ICONS.pending;
    const url = eventUrl(repo, ev);
    if (url) {
      return (
        <a
          key={i}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${styles.eventIcon} ${cls}`}
        >
          {icon}
        </a>
      );
    }
    return (
      <span key={i} className={`${styles.eventIcon} ${cls}`}>
        {icon}
      </span>
    );
  });

  return (
    <>
      <td
        className={`${styles.colSignal} ${highlightClass} ${isExpanded ? styles.colSignalExpanded : ""}`}
      >
        <Tooltip
          title={tooltipContent}
          arrow
          placement="bottom"
          slotProps={{
            tooltip: {
              sx: { maxWidth: 420 },
            },
          }}
        >
          <span>
            {eventIcons}
            {hiddenCount >= 2 && (
              <span
                className={styles.overflowBadge}
                onClick={(e) => {
                  e.stopPropagation();
                  onExpandColumn?.();
                }}
              >
                +{hiddenCount}
              </span>
            )}
            {advisorBadge}
          </span>
        </Tooltip>
      </td>
      {fullAdvisorVerdict && (
        <Popover
          open={Boolean(popoverAnchor)}
          anchorEl={popoverAnchor}
          onClose={() => setPopoverAnchor(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
          transformOrigin={{ vertical: "top", horizontal: "center" }}
        >
          <div style={{ padding: 8, maxWidth: 450 }}>
            <AdvisorSection
              verdict={fullAdvisorVerdict}
              repoOwner={repo.split("/")[0]}
              repoName={repo.split("/")[1]}
            />
          </div>
        </Popover>
      )}
    </>
  );
}
