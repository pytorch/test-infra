/**
 * WorkflowGantt — a per-workflow Gantt / waterfall view, rendered inside a
 * single WorkflowBox on the commit/PR page.
 *
 * Takes the jobs of ONE workflow (the box's jobs) and lays them on a time axis
 * normalized to that workflow's trigger (t=0). Surfaces queue (spin-up) vs run
 * time, pass/fail status, and dependency staggering (tests start after the build
 * they wait on).
 *
 * Coloring:
 *  - "Group" mode: every "/ build" job shares one fixed color; every other job
 *    is colored by its config prefix (job name with the matrix "(...)" and the
 *    test/build role stripped) via a deterministic hash → hue. So shards of the
 *    same config share a color with NO hard-coded keyword lists.
 *  - "Status" mode: colored by CI conclusion.
 *
 * Scale:
 *  - By default the time axis is fit to the panel width (measured via
 *    ResizeObserver), so short workflows (Lint) and long ones (trunk) both fill
 *    the box. "Lock scale" switches to a fixed px/min for cross-box comparison.
 *
 * Data: reuses the JobData[] the box already has — time (started_at), durationS,
 * queueTimeS → created/started/completed. No extra API call / backend change.
 * Loaded lazily (next/dynamic, ssr:false) so it adds nothing until opened.
 */
import { useTheme } from "@mui/material";
import { JobData } from "lib/types";
import { useEffect, useMemo, useRef, useState } from "react";

const BUILD_COLOR = "#1f77b4";
// Vivid status hues read on both light and dark backgrounds. The neutral grays
// (queued/neutral fallbacks) and the queue/spin-up bar are derived from the MUI
// theme at render time instead (see WorkflowGantt), so they adapt to the mode.
const STATUS_COLOR: Record<string, string> = {
  success: "#2e9e44",
  failure: "#e03b3b",
  cancelled: "#f0932b",
  pending: "#1b74e4",
};

const ROW = 16;
const AXIS = 20;
const LBL = 340; // fixed label column width (px); long names scroll within it
const PAD_L = 14; // left padding inside the bars pane (room for the 0m tick)
const RIGHT = 40; // right padding for end-of-bar labels
const FIXED_PXMIN = 3.4; // used when scale is locked
const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720];

// "/ build" already matches "/ build-osdc" as a substring, so no osdc-specific
// handling is needed. "build"/"test" are generic CI role suffixes, not workflow
// or platform names.
function isBuild(n: string) {
  return n.includes("/ build");
}
function shortName(n: string) {
  // Legend label: just strip the leading "<workflow> / " — the box already shows
  // the workflow. (Only ever called on group keys, which carry no runner suffix.)
  return n.includes(" / ") ? n.slice(n.indexOf(" / ") + 3) : n;
}

// Group key: collapses shards of the same config to one key, by dropping the
// trailing matrix "(...)" and the generic role suffix.
//   "... / linux-jammy-cuda13 / test (default, 1, 5, runner)" -> "... / linux-jammy-cuda13"
//   any "/ build" job                                          -> "build"
function groupKeyOf(name: string): string {
  if (isBuild(name)) return "build";
  let s = name.replace(/\s*\([^)]*\)\s*$/, ""); // drop trailing (matrix ...)
  s = s.replace(/\s*\/\s*(test|build)(-osdc)?\b.*$/, ""); // drop role suffix + rest
  return s.trim() || name;
}

// Evenly-spaced hues, computed per box: the distinct config groups present are
// sorted and assigned hues 360/N apart, so they're maximally separated (kills the
// coincidental crowding a global hash produced). "build" is always the fixed
// color. Tradeoff vs hashing: a group's hue can shift if the SET of groups in the
// box changes between commits (spacing is relative to who's present).
function buildColorMap(keys: string[]): Record<string, string> {
  const groups = Array.from(new Set(keys))
    .filter((k) => k !== "build")
    .sort();
  const n = Math.max(groups.length, 1);
  const map: Record<string, string> = { build: BUILD_COLOR };
  groups.forEach((k, i) => {
    map[k] = `hsl(${Math.round((i * 360) / n)}, 58%, 47%)`;
  });
  return map;
}
function statusColor(s: string, neutral: string) {
  return STATUS_COLOR[s] || neutral;
}

function niceStep(span: number, targetTicks: number): number {
  const raw = span / Math.max(1, targetTicks);
  for (const s of NICE_STEPS) if (s >= raw) return s;
  return NICE_STEPS[NICE_STEPS.length - 1];
}

interface PJob {
  full: string;
  label: string;
  groupKey: string;
  co: number;
  so: number;
  eo: number;
  status: string;
  dur: number;
  q: number;
}

function processJobs(
  jobs: JobData[]
): { rows: PJob[]; maxEnd: number; skipped: number } | null {
  const skipped = jobs.filter((j) => j.conclusion === "skipped").length;
  const usable = jobs.filter((j) => {
    if (!j.time || j.durationS == null) return false;
    const ms = new Date(j.time).getTime();
    // Guard against epoch/not-started timestamps (started_at = 0 -> 1970), which
    // would corrupt the shared t0 on in-progress commits.
    if (!isFinite(ms) || new Date(j.time).getUTCFullYear() < 2020) return false;
    // Skipped jobs never ran; their timing is degenerate (e.g. durationS = -1).
    if (j.conclusion === "skipped") return false;
    return true;
  });
  if (usable.length === 0) return null;
  const raw = usable.map((j) => ({
    full: j.name || "",
    label: j.jobName || j.name || "", // full name, matches the job list above
    groupKey: groupKeyOf(j.name || ""),
    startedMin: new Date(j.time as string).getTime() / 60000,
    // clamp: clock skew can make queueTimeS slightly negative; durationS can be
    // negative on degenerate rows. Keep created <= started <= completed.
    q: Math.max((j.queueTimeS || 0) / 60, 0),
    dur: Math.max((j.durationS || 0) / 60, 0),
    status: j.conclusion || "neutral",
  }));
  const t0 = Math.min(...raw.map((p) => p.startedMin - p.q));
  const rows: PJob[] = raw.map((p) => ({
    full: p.full,
    label: p.label,
    groupKey: p.groupKey,
    co: p.startedMin - p.q - t0,
    so: p.startedMin - t0,
    eo: p.startedMin - t0 + p.dur,
    status: p.status,
    dur: p.dur,
    q: p.q,
  }));
  rows.sort((a, b) => a.so - b.so || b.dur - a.dur);
  return { rows, maxEnd: Math.max(...rows.map((r) => r.eo), 1), skipped };
}

function useContainerWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export default function WorkflowGantt({ jobs }: { jobs: JobData[] }) {
  const data = useMemo(() => processJobs(jobs), [jobs]);
  const [colorMode, setColorMode] = useState<"group" | "status">("status");
  const [locked, setLocked] = useState(false);
  const [filter, setFilter] = useState("");
  const [containerRef, containerWidth] = useContainerWidth();
  const theme = useTheme();
  // Chrome/neutral colors must work on light and dark backgrounds (torchci
  // guideline): take border/muted-text from the palette, and pick the queue and
  // neutral-status grays by mode so they don't wash out on either background.
  const muted = theme.palette.text.secondary;
  const borderColor = theme.palette.divider;
  const neutralColor = theme.palette.mode === "dark" ? "#7a7d82" : "#9aa0a6";
  const queueColor = theme.palette.mode === "dark" ? "#4a4a4a" : "#d9d9d9";
  // NOTE: we intentionally do NOT draw dependency edges. They can only be inferred
  // from timing (created ~ completed of a predecessor), which is a guess, not the
  // real `needs` DAG — it mislabels parallel siblings and multi-needs jobs. The
  // bars below are exact; the build->test staggering is visible from positions.

  if (!data) {
    return (
      <div style={{ padding: 8, fontSize: 12, color: muted }}>
        No timing data available for this workflow.
      </div>
    );
  }

  const { rows, maxEnd, skipped } = data;
  // Built from ALL jobs so a job keeps its color when the list is filtered.
  const colorMap = buildColorMap(rows.map((r) => r.groupKey));
  // Row-visibility mask only: the time axis stays derived from all jobs (below),
  // so filtering never reorients the timeline. Plain substring, not regex.
  // Match the displayed row label (the prefix-less job name). full (=name) only
  // adds the constant "<workflow> / " prefix, so it can't narrow within a box.
  const query = filter.trim().toLowerCase();
  const visibleRows = query
    ? rows.filter((r) => r.label.toLowerCase().includes(query))
    : rows;
  const nFail = visibleRows.filter((r) => r.status === "failure").length;

  // px/minute: fit the (measured) bars pane by default, fixed when locked. The
  // plot keeps a readable minimum and scrolls horizontally instead of squishing.
  const effW = containerWidth || 700;
  const fitPxMin = Math.max((effW - PAD_L - RIGHT) / maxEnd, 0.6);
  const pxmin = locked ? FIXED_PXMIN : fitPxMin;

  const plotW = maxEnd * pxmin;
  const W = PAD_L + plotW + RIGHT;
  const H = AXIS + visibleRows.length * ROW + 8;
  const xat = (m: number) => PAD_L + m * pxmin;

  const targetTicks = Math.max(2, Math.round(plotW / 100));
  const step = niceStep(maxEnd, targetTicks);
  const grid: number[] = [];
  for (let m = 0; m <= maxEnd + 1e-6; m += step) grid.push(Math.round(m));

  const colorOf = (r: PJob) =>
    colorMode === "group"
      ? colorMap[r.groupKey]
      : statusColor(r.status, neutralColor);

  // legend entries for current mode
  const legend =
    colorMode === "group"
      ? Array.from(new Set(visibleRows.map((r) => r.groupKey)))
          .sort((a, b) =>
            a === "build" ? -1 : b === "build" ? 1 : a.localeCompare(b)
          )
          .map((k) => ({
            color: colorMap[k],
            label: k === "build" ? "build" : shortName(k),
          }))
      : Array.from(new Set(visibleRows.map((r) => r.status))).map((s) => ({
          color: statusColor(s, neutralColor),
          label: s,
        }));

  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        margin: "6px 0",
        background: "rgba(127,127,127,0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
          padding: "6px 10px",
          fontSize: 12,
        }}
      >
        <span style={{ color: muted }}>
          {query
            ? `${visibleRows.length} of ${rows.length} jobs`
            : `${rows.length} jobs`}{" "}
          · {Math.round(maxEnd)} min
          {nFail > 0 && (
            <span style={{ color: "#e03b3b" }}> · {nFail} failing</span>
          )}
          {skipped > 0 && ` · ${skipped} skipped hidden`}
        </span>
        <span>
          <span style={{ color: muted, marginRight: 6 }}>Color:</span>
          <label style={{ marginRight: 8 }}>
            <input
              type="radio"
              checked={colorMode === "status"}
              onChange={() => setColorMode("status")}
            />{" "}
            Status
          </label>
          <label>
            <input
              type="radio"
              checked={colorMode === "group"}
              onChange={() => setColorMode("group")}
            />{" "}
            Group
          </label>
        </span>
        <label title="Fit to panel width by default; lock for a fixed px/min so bars are comparable across workflow boxes.">
          <input
            type="checkbox"
            checked={locked}
            onChange={(e) => setLocked(e.target.checked)}
          />{" "}
          Lock scale
        </label>
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          title="Show only jobs whose name contains this text (case-insensitive substring). The timeline scale is unchanged — matched bars keep their positions."
        >
          <span style={{ color: muted }}>Filter:</span>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by job name"
            aria-label="Filter jobs by name"
            style={{
              fontSize: 12,
              padding: "2px 6px",
              width: 200,
              border: `1px solid ${borderColor}`,
              borderRadius: 4,
            }}
          />
        </span>
      </div>

      {query && visibleRows.length === 0 && (
        <div style={{ padding: "4px 10px", fontSize: 12, color: muted }}>
          No jobs match “{filter.trim()}”.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-start" }}>
        {/* Label column: fixed width. Scrolls horizontally ONLY when a job name
            is longer than the column, so one long name doesn't widen everything. */}
        <div
          style={{
            flex: "0 0 auto",
            width: LBL,
            overflowX: "auto",
            overflowY: "hidden",
          }}
        >
          <div style={{ height: AXIS }} />
          {visibleRows.map((j, i) => (
            <div
              key={i}
              title={j.full}
              style={{
                height: ROW,
                lineHeight: `${ROW}px`,
                fontSize: 9,
                whiteSpace: "nowrap",
                paddingLeft: 6,
              }}
            >
              {j.label}
            </div>
          ))}
        </div>

        {/* Bars: fit the pane width by default, horizontal scroll when needed. */}
        <div
          ref={containerRef}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowX: "auto",
            marginLeft: 10,
          }}
        >
          <svg
            width={W}
            height={H}
            style={{ display: "block", maxWidth: "none" }}
          >
            {grid.map((m) => (
              <g key={m}>
                <line
                  x1={xat(m)}
                  y1={AXIS - 4}
                  x2={xat(m)}
                  y2={H}
                  stroke="currentColor"
                  strokeOpacity={0.12}
                />
                <text
                  x={xat(m)}
                  y={AXIS - 7}
                  fontSize={9}
                  fill="currentColor"
                  fillOpacity={0.5}
                  textAnchor="middle"
                >
                  {m}m
                </text>
              </g>
            ))}
            {visibleRows.map((j, i) => {
              const y = AXIS + i * ROW;
              const bh = ROW - 4;
              const qw = Math.max((j.so - j.co) * pxmin, 0);
              const bw = Math.max((j.eo - j.so) * pxmin, 1.4);
              return (
                <g key={i}>
                  {qw > 0.5 && (
                    <rect
                      x={xat(j.co)}
                      y={y}
                      width={qw}
                      height={bh}
                      fill={queueColor}
                    />
                  )}
                  <rect
                    x={xat(j.so)}
                    y={y}
                    width={bw}
                    height={bh}
                    rx={2}
                    fill={colorOf(j)}
                  >
                    <title>
                      {`${j.full}\nstatus: ${j.status}\nstart @${j.so.toFixed(
                        1
                      )}m · end @${j.eo.toFixed(1)}m · ${j.dur.toFixed(
                        1
                      )} min\nqueue ${j.q.toFixed(1)}m`}
                    </title>
                  </rect>
                  {bw >= 28 && (
                    <text
                      x={xat(j.eo) + 3}
                      y={y + bh - 2}
                      fontSize={8}
                      fill="currentColor"
                      fillOpacity={0.55}
                    >
                      {Math.round(j.dur)}m
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          padding: "6px 10px",
          fontSize: 11,
          color: muted,
        }}
      >
        {legend.map((e) => (
          <span
            key={e.label}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <span
              style={{
                width: 11,
                height: 10,
                borderRadius: 2,
                background: e.color,
                display: "inline-block",
              }}
            />
            {e.label}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 11,
              height: 10,
              borderRadius: 2,
              background: queueColor,
            }}
          />
          queue/spin-up
        </span>
      </div>
    </div>
  );
}
