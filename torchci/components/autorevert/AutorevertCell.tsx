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
  // Full advisor verdict from the dedicated CH table (has run_id, summary, etc.)
  fullAdvisorVerdict?: AdvisorVerdict;
  repo: string;
}

export default function AutorevertCell({
  events,
  highlight,
  advisorResult,
  advisorDispatchPending,
  fullAdvisorVerdict,
  repo,
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

  const MAX_VISIBLE_EVENTS = 2;
  const hasOverflow = events.length > MAX_VISIBLE_EVENTS;
  // Show last N events (most recent) when there are too many
  const visibleEvents = hasOverflow
    ? events.slice(events.length - MAX_VISIBLE_EVENTS)
    : events;

  function renderEventIcon(ev: CellEvent, i: number) {
    const { icon, cls } = STATUS_ICONS[ev.status] || STATUS_ICONS.pending;
    const url = eventUrl(repo, ev);
    const tip = `${ev.status} — ${ev.started_at}${ev.run_attempt ? ` (attempt ${ev.run_attempt})` : ""}\n${ev.name}`;

    if (url) {
      return (
        <Tooltip key={i} title={<span style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>{tip}</span>} arrow>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${styles.eventIcon} ${cls}`}
          >
            {icon}
          </a>
        </Tooltip>
      );
    }
    return (
      <Tooltip key={i} title={<span style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>{tip}</span>} arrow>
        <span className={`${styles.eventIcon} ${cls}`}>
          {icon}
        </span>
      </Tooltip>
    );
  }

  const eventIcons = (
    <>
      {hasOverflow && (
        <Tooltip
          title={
            <span style={{ fontSize: "0.9rem" }}>
              {events.length - MAX_VISIBLE_EVENTS} earlier event(s) hidden
            </span>
          }
          arrow
        >
          <span className={styles.eventIcon} style={{ opacity: 0.4, fontSize: "0.7rem" }}>
            +{events.length - MAX_VISIBLE_EVENTS}
          </span>
        </Tooltip>
      )}
      {visibleEvents.map((ev, i) => renderEventIcon(ev, i))}
    </>
  );

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
      <span className={`${styles.advisorBadge} ${styles.advPending}`} title="AI advisor dispatched, awaiting result">
        …
      </span>
    );
  }

  if (events.length === 0 && !advisorBadge) {
    return <td className={`${styles.colSignal} ${highlightClass}`} />;
  }

  return (
    <>
      <td className={`${styles.colSignal} ${highlightClass}`}>
        {eventIcons}
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
