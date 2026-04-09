import AdvisorSection from "components/job/AdvisorSection";
import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { useRef, useState } from "react";
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
  advisorWasDispatched?: boolean;
  fullAdvisorVerdict?: AdvisorVerdict;
  repo: string;
  isExpanded?: boolean;
  onExpandColumn?: () => void;
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
  advisorWasDispatched,
  fullAdvisorVerdict,
  repo,
  isExpanded,
  onExpandColumn,
  signalKey,
  workflowName,
}: AutorevertCellProps) {
  const [visible, setVisible] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const highlightCls = highlight
    ? {
        suspected: styles.cellSuspected,
        baseline: styles.cellBaseline,
        "newer-fail": styles.cellNewerFail,
        restart: styles.cellRestart,
      }[highlight]
    : "";
  const dispatchCls = advisorWasDispatched ? styles.cellAdvisorDispatch : "";
  const highlightClass = `${highlightCls} ${dispatchCls}`;

  const MAX_VISIBLE = 2;
  const showAll = isExpanded || events.length <= MAX_VISIBLE;
  const visibleEvents = showAll
    ? events
    : events.slice(events.length - MAX_VISIBLE);
  const hiddenCount = events.length - visibleEvents.length;

  // Advisor badge
  let advisorBadge = null;
  if (fullAdvisorVerdict) {
    const cls = ADV_VERDICT_CLS[fullAdvisorVerdict.verdict] || styles.advUnsure;
    const short = ADV_VERDICT_SHORT[fullAdvisorVerdict.verdict] || "?";
    advisorBadge = (
      <span className={`${styles.advisorBadge} ${cls}`}>{short}</span>
    );
  } else if (advisorResult) {
    const cls = ADV_VERDICT_CLS[advisorResult.verdict] || styles.advUnsure;
    const short = ADV_VERDICT_SHORT[advisorResult.verdict] || "?";
    advisorBadge = (
      <span className={`${styles.advisorBadge} ${cls}`}>{short}</span>
    );
  } else if (advisorDispatchPending) {
    advisorBadge = (
      <span className={`${styles.advisorBadge} ${styles.advDispatched}`}>
        AI
      </span>
    );
  }

  if (events.length === 0 && !advisorBadge) {
    return <td className={`${styles.colSignal} ${highlightClass}`} />;
  }

  // Event icons
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

  // Tooltip content
  const tooltipContent = (
    <div className={styles.cellTooltipContent}>
      {signalKey && (
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {workflowName}:{signalKey}
        </div>
      )}

      {highlight === "restart" && (
        <div className={styles.cellTooltipBadgeRow}>
          <span className={`${styles.tlBadge} ${styles.tlRestart}`}>RST</span>
          <span>Targeted for CI restart</span>
        </div>
      )}
      {highlight && highlight !== "restart" && (
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

      {events.length > 0 && (
        <div style={{ marginBottom: 8 }}>
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
                {STATUS_LABELS[ev.status] || ev.status} —{" "}
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
                      style={{ color: "var(--link-color, #1a73e8)" }}
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
        <div style={{ fontSize: "0.8rem", opacity: 0.7, marginBottom: 4 }}>
          No CI runs recorded for this signal on this commit.
        </div>
      )}

      {(fullAdvisorVerdict || advisorResult || advisorWasDispatched) && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--border-color, #ddd)",
          }}
        >
          <div className={styles.cellTooltipSectionLabel}>
            AI Advisor Analysis
          </div>

          {advisorWasDispatched && (
            <div className={styles.cellTooltipBadgeRow}>
              <span className={`${styles.tlBadge} ${styles.tlAdvisor}`}>
                AI
              </span>
              <span>
                Autorevert dispatched an AI advisor to analyze this failure.
                {!fullAdvisorVerdict &&
                  !advisorResult &&
                  " The verdict has not been received yet."}
              </span>
            </div>
          )}

          {fullAdvisorVerdict && (
            <AdvisorSection
              verdict={fullAdvisorVerdict}
              repoOwner={repo.split("/")[0]}
              repoName={repo.split("/")[1]}
            />
          )}

          {advisorResult && !fullAdvisorVerdict && (
            <div style={{ fontSize: "0.8rem" }}>
              <strong>Verdict:</strong> {advisorResult.verdict} (
              {Math.round(advisorResult.confidence * 100)}%)
            </div>
          )}
        </div>
      )}
    </div>
  );

  function handleMouseOver() {
    hoverTimerRef.current = setTimeout(() => setVisible(true), 200);
  }

  function handleMouseLeave() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setVisible(false);
  }

  return (
    <td
      className={`${styles.colSignal} ${highlightClass} ${
        isExpanded ? styles.colSignalExpanded : ""
      } ${styles.cellWrapper}`}
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
    >
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
      {visible && (
        <div
          className={styles.cellTooltipContainer}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.cellTooltip}>{tooltipContent}</div>
        </div>
      )}
    </td>
  );
}
