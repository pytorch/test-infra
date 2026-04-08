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

  // Build tooltip content listing all events
  const tooltipContent = events.length > 0 ? (
    <div style={{ fontSize: "0.85em", lineHeight: 1.5 }}>
      {events.map((ev, i) => {
        const { icon } = STATUS_ICONS[ev.status] || STATUS_ICONS.pending;
        return (
          <div key={i} style={{ whiteSpace: "nowrap" }}>
            {icon} {ev.status} — {ev.started_at}
            {ev.run_attempt ? ` (attempt ${ev.run_attempt})` : ""}
            <br />
            <span style={{ fontSize: "0.85em", opacity: 0.8 }}>{ev.name}</span>
          </div>
        );
      })}
    </div>
  ) : null;

  // Render all events (no aggregation — retries visible)
  const eventIcons = events.map((ev, i) => {
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

  const cellInner = (
    <span>
      {eventIcons}
      {advisorBadge}
    </span>
  );

  return (
    <>
      <td className={`${styles.colSignal} ${highlightClass}`}>
        {tooltipContent ? (
          <Tooltip title={tooltipContent} arrow placement="bottom">
            {cellInner}
          </Tooltip>
        ) : (
          cellInner
        )}
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
