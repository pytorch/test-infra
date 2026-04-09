import { Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import styles from "./autorevert.module.css";
import { AutorevertEventRow, parseChTimestamp } from "./types";

const ACTION_STYLE: Record<
  string,
  { label: string; cls: string; short: string }
> = {
  revert: { label: "Revert", cls: styles.tlRevert, short: "RVT" },
  restart: { label: "Restart", cls: styles.tlRestart, short: "RST" },
  advisor: { label: "AI Advisor", cls: styles.tlAdvisor, short: "AI" },
};

interface TimelineEvent {
  ts: number;
  action: string;
  commitSha: string;
  signalKeys: string[];
}

interface RunTimestamp {
  ts: string;
  workflows: string[];
}

interface EventTimelineProps {
  events: AutorevertEventRow[];
  runTimestamps?: RunTimestamp[];
  commits: string[];
  commitTimes: Record<string, string>;
  tableRef: React.RefObject<HTMLTableElement | null>;
  onTimestampSelect?: (utcTs: string) => void;
}

function formatLocalTime(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export default function EventTimeline({
  events,
  runTimestamps,
  commits,
  commitTimes,
  tableRef,
  onTimestampSelect,
}: EventTimelineProps) {
  const [rowPositions, setRowPositions] = useState<Map<string, number>>(
    new Map()
  );
  const [headerHeight, setHeaderHeight] = useState(0);
  const [tableHeight, setTableHeight] = useState(0);

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
          const midY =
            rect.top +
            rect.height / 2 -
            tableTop +
            thead.getBoundingClientRect().height;
          positions.set(commits[i], midY);
        }
      });
      setRowPositions(positions);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [tableRef, commits]);

  if (rowPositions.size === 0) return null;

  // Time range from commits
  const commitTimestamps = commits.map((sha) =>
    parseChTimestamp(commitTimes[sha])
  );
  const newestTs = commitTimestamps[0];
  const oldestTs = commitTimestamps[commitTimestamps.length - 1];

  function getYForTimestamp(tsMs: number): number {
    for (let i = 0; i < commitTimestamps.length - 1; i++) {
      const newerTs = commitTimestamps[i];
      const olderTs = commitTimestamps[i + 1];
      if (tsMs <= newerTs && tsMs >= olderTs) {
        const newerY = rowPositions.get(commits[i]) ?? 0;
        const olderY = rowPositions.get(commits[i + 1]) ?? 0;
        const ratio =
          newerTs === olderTs
            ? 0.5
            : (newerTs - tsMs) / (newerTs - olderTs);
        return newerY + ratio * (olderY - newerY);
      }
    }
    if (tsMs > newestTs) {
      return Math.max(headerHeight, (rowPositions.get(commits[0]) ?? headerHeight) - 10);
    }
    return rowPositions.get(commits[commits.length - 1]) ?? tableHeight;
  }

  // Parse and filter events
  const timelineEvents: TimelineEvent[] = events
    .map((ev) => ({
      ts: parseChTimestamp(ev.ts),
      action: ev.action,
      commitSha: ev.commit_sha,
      signalKeys: ev.source_signal_keys,
    }))
    .filter((ev) => ev.ts >= oldestTs && ev.ts <= newestTs + 3600000)
    .sort((a, b) => b.ts - a.ts);

  // Position events with horizontal stacking
  const MIN_GAP = 16;
  interface Positioned extends TimelineEvent {
    y: number;
    column: number;
  }
  const positioned: Positioned[] = [];
  for (const ev of timelineEvents) {
    const y = getYForTimestamp(ev.ts);
    let column = 0;
    for (const existing of positioned) {
      if (Math.abs(existing.y - y) < MIN_GAP && existing.column === column) {
        column++;
      }
    }
    positioned.push({ ...ev, y, column });
  }

  // Parse run timestamps for the dots line
  const runDots = (runTimestamps || [])
    .map((r) => ({
      ts: parseChTimestamp(r.ts),
      workflows: r.workflows,
    }))
    .filter((r) => r.ts >= oldestTs && r.ts <= newestTs + 3600000)
    .sort((a, b) => b.ts - a.ts);

  const maxColumn = Math.max(0, ...positioned.map((e) => e.column));
  const badgesWidth = (maxColumn + 1) * 36;
  const runsLineWidth = 14;
  const timelineWidth = badgesWidth + runsLineWidth + 12;

  const handleClick = (tsMs: number) => {
    if (onTimestampSelect) {
      const iso = new Date(tsMs).toISOString();
      onTimestampSelect(iso);
    }
  };

  return (
    <div
      className={styles.timeline}
      style={{ width: timelineWidth, minWidth: timelineWidth }}
    >
      {/* Title */}
      <div className={styles.tlTitle}>Activity</div>

      {/* Runs line — vertical line with dots for each autorevert run */}
      <div
        className={styles.runsLine}
        style={{
          top: headerHeight,
          height: tableHeight - headerHeight,
          right: 0,
        }}
      >
        {runDots.map((dot, i) => {
          const y = getYForTimestamp(dot.ts) - headerHeight;
          return (
            <Tooltip
              key={i}
              title={
                <span style={{ fontSize: "0.85rem" }}>
                  Autorevert run · {formatLocalTime(dot.ts)}
                  <br />
                  Click to view this snapshot
                </span>
              }
              arrow
              placement="left"
            >
              <span
                className={styles.runDot}
                style={{ top: y - 3 }}
                onClick={() => handleClick(dot.ts)}
              />
            </Tooltip>
          );
        })}
      </div>

      {/* Event badges */}
      {positioned.map((ev, i) => {
        const style = ACTION_STYLE[ev.action] || ACTION_STYLE.restart;
        return (
          <Tooltip
            key={i}
            title={
              <div style={{ fontSize: "0.85rem" }}>
                <div style={{ fontWeight: 600 }}>
                  {style.label} · {formatLocalTime(ev.ts)}
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
                <div
                  style={{
                    marginTop: 4,
                    color: "#90caf9",
                    fontSize: "0.8rem",
                  }}
                >
                  Click to view snapshot
                </div>
              </div>
            }
            arrow
            placement="left"
          >
            <span
              className={`${styles.tlBadge} ${style.cls}`}
              style={{
                top: ev.y - 7,
                right: ev.column * 36 + runsLineWidth + 8,
                cursor: "pointer",
              }}
              onClick={() => handleClick(ev.ts)}
            >
              {style.short}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
