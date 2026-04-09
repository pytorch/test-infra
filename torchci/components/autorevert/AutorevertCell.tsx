import { Popover, Tooltip } from "@mui/material";
import AdvisorSection from "components/job/AdvisorSection";
import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { useState } from "react";
import styles from "./autorevert.module.css";
import {
  CellEvent,
  CellHighlight,
  ColumnAdvisorResult,
  eventUrl,
} from "./types";

const STATUS_ICONS: Record<string, { icon: string; cls: string }> = {
  success: { icon: "✓", cls: styles.statusSuccess },
  failure: { icon: "✗", cls: styles.statusFailure },
  pending: { icon: "●", cls: styles.statusPending },
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
}

function EventIcon({
  ev,
  repo,
}: {
  ev: CellEvent;
  repo: string;
}) {
  const { icon, cls } = STATUS_ICONS[ev.status] || STATUS_ICONS.pending;
  const url = eventUrl(repo, ev);
  const tip = [
    `${ev.status}${ev.run_attempt ? ` (attempt ${ev.run_attempt})` : ""}`,
    ev.started_at,
    ev.name,
  ].join("\n");

  const inner = url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${styles.eventIcon} ${cls}`}
    >
      {icon}
    </a>
  ) : (
    <span className={`${styles.eventIcon} ${cls}`}>{icon}</span>
  );

  return (
    <Tooltip
      title={
        <span style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>
          {tip}
        </span>
      }
      arrow
    >
      {inner}
    </Tooltip>
  );
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

  // Advisor badge
  let advisorBadge = null;
  if (advisorResult) {
    const cls = ADV_VERDICT_CLS[advisorResult.verdict] || styles.advUnsure;
    const short = ADV_VERDICT_SHORT[advisorResult.verdict] || "?";
    advisorBadge = (
      <span
        className={`${styles.advisorBadge} ${cls}`}
        title={`AI: ${advisorResult.verdict} (${Math.round(advisorResult.confidence * 100)}%)`}
        onClick={(e) => {
          e.stopPropagation();
          setPopoverAnchor(e.currentTarget);
        }}
      >
        {short}
      </span>
    );
  } else if (advisorDispatchPending) {
    advisorBadge = (
      <span
        className={`${styles.advisorBadge} ${styles.advPending}`}
        title="AI advisor dispatched, awaiting result"
      >
        …
      </span>
    );
  }

  if (events.length === 0 && !advisorBadge) {
    return <td className={`${styles.colSignal} ${highlightClass}`} />;
  }

  return (
    <>
      <td
        className={`${styles.colSignal} ${highlightClass} ${isExpanded ? styles.colSignalExpanded : ""}`}
      >
        {visibleEvents.map((ev, i) => (
          <EventIcon key={i} ev={ev} repo={repo} />
        ))}
        {hiddenCount >= 2 && (
          <Tooltip
            title={
              <span style={{ fontSize: "0.9rem" }}>
                {hiddenCount} earlier events — click to expand column
              </span>
            }
            arrow
          >
            <span
              className={styles.overflowBadge}
              onClick={(e) => {
                e.stopPropagation();
                onExpandColumn?.();
              }}
            >
              +{hiddenCount}
            </span>
          </Tooltip>
        )}
        {advisorBadge}
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
