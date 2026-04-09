import { Tooltip } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import styles from "./autorevert.module.css";
import { AutorevertEventRow, ensureUtc, parseChTimestamp } from "./types";

const ACTION_STYLE: Record<
  string,
  { label: string; cls: string; short: string }
> = {
  revert: { label: "Revert", cls: styles.tlRevert, short: "RVT" },
  restart: { label: "Restart", cls: styles.tlRestart, short: "RST" },
  advisor: { label: "AI Advisor", cls: styles.tlAdvisor, short: "AI" },
};

interface TimelineEvent {
  ts: number; // UTC millis
  action: string;
  commitSha: string;
  signalKeys: string[];
  raw: AutorevertEventRow;
}

interface EventTimelineProps {
  events: AutorevertEventRow[];
  commits: string[]; // newest first
  commitTimes: Record<string, string>;
  tableRef: React.RefObject<HTMLTableElement | null>;
}

/**
 * Renders autorevert events as badges on a proportional timeline
 * to the left of the signal grid table.
 *
 * The vertical position of each badge is interpolated between
 * the table rows of the surrounding commits based on the event timestamp.
 */
export default function EventTimeline({
  events,
  commits,
  commitTimes,
  tableRef,
}: EventTimelineProps) {
  const [rowPositions, setRowPositions] = useState<Map<string, number>>(
    new Map()
  );
  const [headerHeight, setHeaderHeight] = useState(0);
  const [tableHeight, setTableHeight] = useState(0);

  // Measure row positions from the table DOM
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;

    const measure = () => {
      const tbody = table.querySelector("tbody");
      const thead = table.querySelector("thead");
      if (!tbody || !thead) return;

      setHeaderHeight(thead.getBoundingClientRect().height);
      setTableHeight(
        thead.getBoundingClientRect().height +
          tbody.getBoundingClientRect().height
      );

      const positions = new Map<string, number>();
      const rows = tbody.querySelectorAll("tr");
      const tableTop = thead.getBoundingClientRect().bottom;

      rows.forEach((row, i) => {
        if (i < commits.length) {
          const rect = row.getBoundingClientRect();
          const midY = rect.top + rect.height / 2 - tableTop + thead.getBoundingClientRect().height;
          positions.set(commits[i], midY);
        }
      });
      setRowPositions(positions);
    };

    measure();
    // Re-measure on resize
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [tableRef, commits]);

  if (events.length === 0 || rowPositions.size === 0) return null;

  // Parse commit timestamps (newest first, so index 0 = latest time)
  const commitTimestamps = commits.map((sha) =>
    parseChTimestamp(commitTimes[sha])
  );

  // Parse events
  const timelineEvents: TimelineEvent[] = events
    .map((ev) => ({
      ts: parseChTimestamp(ev.ts),
      action: ev.action,
      commitSha: ev.commit_sha,
      signalKeys: ev.source_signal_keys,
      raw: ev,
    }))
    .filter((ev) => {
      // Only show events within the time range of visible commits
      const newest = commitTimestamps[0];
      const oldest = commitTimestamps[commitTimestamps.length - 1];
      return ev.ts >= oldest && ev.ts <= newest + 3600000; // +1h buffer
    })
    .sort((a, b) => b.ts - a.ts); // newest first

  /**
   * Interpolate Y position for a timestamp between commit rows.
   * Finds the two surrounding commits and linearly interpolates.
   */
  function getYForTimestamp(tsMs: number): number {
    // Commits are newest→oldest, timestamps are decreasing
    // Find the two commits that bracket this timestamp
    for (let i = 0; i < commitTimestamps.length - 1; i++) {
      const newerTs = commitTimestamps[i];
      const olderTs = commitTimestamps[i + 1];
      const newerSha = commits[i];
      const olderSha = commits[i + 1];

      if (tsMs <= newerTs && tsMs >= olderTs) {
        const newerY = rowPositions.get(newerSha) ?? 0;
        const olderY = rowPositions.get(olderSha) ?? 0;
        // Linear interpolation
        const ratio =
          newerTs === olderTs
            ? 0.5
            : (newerTs - tsMs) / (newerTs - olderTs);
        return newerY + ratio * (olderY - newerY);
      }
    }

    // Above newest commit
    if (tsMs > commitTimestamps[0]) {
      const topY = rowPositions.get(commits[0]) ?? headerHeight;
      return Math.max(headerHeight, topY - 10);
    }

    // Below oldest commit
    const bottomY =
      rowPositions.get(commits[commits.length - 1]) ?? tableHeight;
    return bottomY;
  }

  // Position events, handling horizontal stacking for overlaps
  interface PositionedEvent extends TimelineEvent {
    y: number;
    column: number;
  }

  const positioned: PositionedEvent[] = [];
  const MIN_VERTICAL_GAP = 16; // minimum pixels between badges

  for (const ev of timelineEvents) {
    const y = getYForTimestamp(ev.ts);

    // Find horizontal column — avoid vertical overlap with existing badges
    let column = 0;
    for (const existing of positioned) {
      if (
        Math.abs(existing.y - y) < MIN_VERTICAL_GAP &&
        existing.column === column
      ) {
        column++;
      }
    }
    positioned.push({ ...ev, y, column });
  }

  const maxColumn = Math.max(0, ...positioned.map((e) => e.column));
  const timelineWidth = (maxColumn + 1) * 36 + 8;

  return (
    <div
      className={styles.timeline}
      style={{ width: timelineWidth, minWidth: timelineWidth }}
    >
      {positioned.map((ev, i) => {
        const style = ACTION_STYLE[ev.action] || ACTION_STYLE.restart;
        const localTime = new Date(ev.ts).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        const tooltipContent = (
          <div style={{ fontSize: "0.85rem" }}>
            <div style={{ fontWeight: 600 }}>
              {style.label} · {localTime}
            </div>
            <div style={{ marginTop: 2, opacity: 0.8 }}>
              {ev.commitSha.slice(0, 7)}
            </div>
            {ev.signalKeys.length > 0 && (
              <div
                style={{
                  marginTop: 4,
                  maxWidth: 300,
                  fontSize: "0.8rem",
                  wordBreak: "break-word",
                }}
              >
                {ev.signalKeys.map((k, j) => (
                  <div key={j}>{k}</div>
                ))}
              </div>
            )}
          </div>
        );

        return (
          <Tooltip key={i} title={tooltipContent} arrow placement="left">
            <span
              className={`${styles.tlBadge} ${style.cls}`}
              style={{
                top: ev.y - 7,
                right: ev.column * 36 + 4,
              }}
            >
              {style.short}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
