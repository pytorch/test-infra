import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import styles from "./autorevert.module.css";
import { AutorevertEventRow, parseChTimestamp } from "./types";

const ACTION_STYLE: Record<
  string,
  { label: string; cls: string; short: string; order: number }
> = {
  revert: { label: "Revert", cls: styles.tlRevert, short: "RVT", order: 0 },
  advisor: {
    label: "AI Advisor",
    cls: styles.tlAdvisor,
    short: "AI",
    order: 1,
  },
  restart: {
    label: "Restart",
    cls: styles.tlRestart,
    short: "RST",
    order: 2,
  },
};

interface RunTimestamp {
  ts: string;
  workflows: string[];
}

interface SnapshotGroup {
  runTs: number;
  counts: { action: string; count: number }[];
  events: AutorevertEventRow[];
}

interface EventTimelineProps {
  events: AutorevertEventRow[];
  runTimestamps?: RunTimestamp[];
  commits: string[];
  commitTimes: Record<string, string>;
  tableRef: React.RefObject<HTMLTableElement | null>;
  onTimestampSelect?: (utcTs: string) => void;
  currentSnapshotTs?: string; // the currently displayed snapshot timestamp
}

function formatLocalTime(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

// Fixed width — always reserved so the grid doesn't jump
const RUNS_LINE_WIDTH = 14;
const TIMELINE_WIDTH = 180;

export default function EventTimeline({
  events,
  runTimestamps,
  commits,
  commitTimes,
  tableRef,
  onTimestampSelect,
  currentSnapshotTs,
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

  // Always render the container for stable width
  if (rowPositions.size === 0) {
    return (
      <div
        className={styles.timeline}
        style={{ width: TIMELINE_WIDTH, minWidth: TIMELINE_WIDTH }}
      />
    );
  }

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
      return Math.max(
        headerHeight,
        (rowPositions.get(commits[0]) ?? headerHeight) - 10
      );
    }
    return rowPositions.get(commits[commits.length - 1]) ?? tableHeight;
  }

  // Parse run timestamps for dots
  const currentTs = currentSnapshotTs
    ? parseChTimestamp(currentSnapshotTs)
    : null;
  const runDots = (runTimestamps || [])
    .map((r) => ({
      ts: parseChTimestamp(r.ts),
      workflows: r.workflows,
      isCurrent: currentTs !== null && Math.abs(parseChTimestamp(r.ts) - currentTs) < 2000,
    }))
    .filter((r) => r.ts >= oldestTs && r.ts <= newestTs + 3600000)
    .sort((a, b) => b.ts - a.ts);

  // Ensure current snapshot has a dot even if not in runTimestamps
  const hasCurrentDot = runDots.some((d) => d.isCurrent);
  if (currentTs && !hasCurrentDot && currentTs >= oldestTs && currentTs <= newestTs + 3600000) {
    runDots.push({ ts: currentTs, workflows: [], isCurrent: true });
    runDots.sort((a, b) => b.ts - a.ts);
  }

  // Group events by nearest run snapshot, then build per-group badges
  const filteredEvents = events
    .map((ev) => ({ ...ev, tsMs: parseChTimestamp(ev.ts) }))
    .filter((ev) => ev.tsMs >= oldestTs && ev.tsMs <= newestTs + 3600000);

  const snapshotGroups: (SnapshotGroup & { y: number })[] = [];
  if (runDots.length > 0 && filteredEvents.length > 0) {
    const groupMap = new Map<number, AutorevertEventRow[]>();
    for (const ev of filteredEvents) {
      let bestRun = runDots[0].ts;
      for (const dot of runDots) {
        if (dot.ts <= ev.tsMs) {
          bestRun = dot.ts;
          break;
        }
      }
      const list = groupMap.get(bestRun) || [];
      list.push(ev);
      groupMap.set(bestRun, list);
    }

    for (const [runTs, groupEvents] of groupMap) {
      const countMap = new Map<string, number>();
      for (const ev of groupEvents) {
        countMap.set(ev.action, (countMap.get(ev.action) || 0) + 1);
      }
      const counts = Array.from(countMap.entries())
        .map(([action, count]) => ({ action, count }))
        .sort(
          (a, b) =>
            (ACTION_STYLE[a.action]?.order ?? 9) -
            (ACTION_STYLE[b.action]?.order ?? 9)
        );

      snapshotGroups.push({
        runTs,
        y: getYForTimestamp(runTs),
        counts,
        events: groupEvents,
      });
    }
  }

  // Position groups with vertical anti-overlap (same as before for individual badges)
  const MIN_GAP = 18;
  const positionedYs: number[] = [];
  for (const group of snapshotGroups) {
    let y = group.y;
    for (const existingY of positionedYs) {
      if (Math.abs(existingY - y) < MIN_GAP) {
        y = existingY + MIN_GAP;
      }
    }
    group.y = y;
    positionedYs.push(y);
  }

  const handleClick = (tsMs: number) => {
    if (onTimestampSelect) {
      onTimestampSelect(new Date(tsMs).toISOString());
    }
  };

  return (
    <div
      className={styles.timeline}
      style={{
        width: TIMELINE_WIDTH,
        minWidth: TIMELINE_WIDTH,
        height: tableHeight,
      }}
    >
      {/* Title with info tooltip */}
      <div className={styles.tlTitle}>
        <span>Actions</span>
        <Tooltip
          title={
            <span style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
              Shows when autorevert ran (dots on the line) and what actions it
              took.
              <br />
              <strong>RST</strong> = restarted CI to confirm failure
              <br />
              <strong>RVT</strong> = triggered a revert
              <br />
              <strong>AI</strong> = dispatched AI advisor for analysis
              <br />
              <br />
              Click any dot or badge to jump to that snapshot.
            </span>
          }
          arrow
          placement="bottom"
        >
          <InfoOutlinedIcon
            sx={{ fontSize: 11, ml: 0.3, opacity: 0.6, cursor: "help" }}
          />
        </Tooltip>
      </div>

      {/* Runs line */}
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
                  {dot.isCurrent
                    ? "Current snapshot"
                    : "Autorevert run"}{" "}
                  · {formatLocalTime(dot.ts)}
                  {!dot.isCurrent && (
                    <>
                      <br />
                      Click to view this snapshot
                    </>
                  )}
                </span>
              }
              arrow
              placement="left"
            >
              <span
                className={`${styles.runDot} ${dot.isCurrent ? styles.runDotCurrent : ""}`}
                style={{ top: y - (dot.isCurrent ? 4 : 3) }}
                onClick={() => !dot.isCurrent && handleClick(dot.ts)}
              />
            </Tooltip>
          );
        })}
        {/* "here" label for current snapshot */}
        {currentTs && (() => {
          const currentDot = runDots.find((d) => d.isCurrent);
          if (!currentDot) return null;
          const y = getYForTimestamp(currentDot.ts) - headerHeight;
          return (
            <span
              className={styles.hereLabel}
              style={{ top: y + 6 }}
            >
              showing this snapshot
            </span>
          );
        })()}
      </div>

      {/* Grouped event badges — absolutely positioned, overflow hidden on left */}
      {snapshotGroups.map((group, gi) => (
        <div
          key={gi}
          className={styles.tlGroup}
          style={{ top: group.y - 8 }}
        >
          {group.counts.map((c, ci) => {
            const st = ACTION_STYLE[c.action] || ACTION_STYLE.restart;
            const groupSignals = group.events
              .filter((e) => e.action === c.action)
              .flatMap((e) => e.source_signal_keys);
            return (
              <Tooltip
                key={ci}
                title={
                  <div style={{ fontSize: "0.85rem" }}>
                    <div style={{ fontWeight: 600 }}>
                      {c.count} {st.label}
                      {c.count > 1 ? "s" : ""} ·{" "}
                      {formatLocalTime(group.runTs)}
                    </div>
                    {groupSignals.length > 0 && (
                      <div
                        style={{
                          marginTop: 4,
                          maxWidth: 300,
                          fontSize: "0.8rem",
                          wordBreak: "break-word",
                        }}
                      >
                        {groupSignals.slice(0, 5).map((k, j) => (
                          <div key={j}>{k}</div>
                        ))}
                        {groupSignals.length > 5 && (
                          <div style={{ opacity: 0.7 }}>
                            +{groupSignals.length - 5} more
                          </div>
                        )}
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
                  className={`${styles.tlBadge} ${st.cls}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => handleClick(group.runTs)}
                >
                  {c.count > 1 ? `${c.count} ` : ""}
                  {st.short}
                </span>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </div>
  );
}
