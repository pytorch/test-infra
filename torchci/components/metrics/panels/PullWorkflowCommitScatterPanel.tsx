import {
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { useEffect, useMemo, useState } from "react";

type CommitRow = {
  ts: string;
  sha: string;
  wallclock_hours: number;
  longest_job_hours: number;
  build_test_hours: number;
  crit_conclusion: "success" | "failure" | "cancelled";
  commit_title: string;
  land_time: string;
};

// Rolling baseline + anomaly flag, computed client-side over a user-selectable
// trailing window (the query returns raw per-commit durations only).
type EnrichedRow = CommitRow & { baseline_median: number; flagged: boolean };

const MAX_FLAGGED_TABLE_ROWS = 50;
const MEDIAN_WINDOW_OPTIONS = [10, 25, 50, 100, 200];
const LINK_COLOR = "#4493f8";
// A cancelled/failed metric-driving job inflates the build+test height, so
// color those points differently from genuinely-slow successful commits.
const CONCLUSION_COLOR: Record<string, string> = {
  success: "#8891a0",
  failure: "#d32f2f",
  cancelled: "#f5a623",
};

function commitUrl(sha: string): string {
  return `https://hud.pytorch.org/pytorch/pytorch/commit/${sha}`;
}

// Commit titles go into tooltip HTML verbatim and routinely contain <, >, & and
// quotes (e.g. template args in C++ op names), so they must be escaped.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateTitle(title: string, maxLen: number = 80): string {
  return title.length > maxLen ? `${title.substring(0, maxLen)}…` : title;
}

// Exact quantile of an ascending-sorted array: the median (q=0.5) averages the
// two middle elements on even counts; other q interpolate between neighbors.
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export default function PullWorkflowCommitScatterPanel({
  startTime,
  stopTime,
  focusStart,
  focusStop,
  chartHeight = 320,
}: {
  startTime: string;
  stopTime: string;
  focusStart?: string;
  focusStop?: string;
  chartHeight?: number;
}) {
  const { darkMode } = useDarkMode();
  const { data } = useClickHouseAPIImmutable<CommitRow>(
    "pull_workflow_duration_per_commit_detail",
    { startTime, stopTime }
  );
  // Trailing-window size (commits) for the rolling-median baseline; also drives
  // which commits get flagged as anomalies.
  const [medianWindow, setMedianWindow] = useState(200);
  // Time window currently visible on the x-axis (ms epoch). null = full range.
  // Seed it from the pre-zoom focus so the table matches the initial view.
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(
    focusStart && focusStop
      ? [Date.parse(focusStart), Date.parse(focusStop)]
      : null
  );
  // router.query.focus is undefined until Next hydrates, so the useState seed
  // above can miss it; re-sync the table window when the focus props arrive or
  // change. Fires only on focus-prop changes, not on user zoom (which updates
  // visibleRange directly), so it doesn't fight manual zooming.
  useEffect(() => {
    if (focusStart && focusStop) {
      setVisibleRange([Date.parse(focusStart), Date.parse(focusStop)]);
    }
  }, [focusStart, focusStop]);

  // Sole source of the baseline + anomaly flag (moved off ClickHouse so the
  // window is configurable without a re-query). For each commit, the baseline
  // is the exact median of the trailing `medianWindow` commits (excluding the
  // commit itself); a commit is flagged when it is BOTH >10% over that median
  // AND above the trailing p90 (a spread gate, so single-commit noise near the
  // median is not flagged). The warm-up gate suppresses flags until the
  // trailing window is meaningful: min(medianWindow, 50) commits, matching the
  // old fixed gate of 50 at the 200 default. Naive O(n·window·log window) is
  // fine at this data size, and the result is memoized.
  const enriched: EnrichedRow[] = useMemo(() => {
    const rows = data ?? [];
    return rows.map((r, i) => {
      const trailing = rows
        .slice(Math.max(0, i - medianWindow), i)
        .map((p) => p.build_test_hours)
        .sort((a, b) => a - b);
      const baseline_median = quantileSorted(trailing, 0.5);
      const baseline_p90 = quantileSorted(trailing, 0.9);
      const flagged =
        trailing.length >= Math.min(medianWindow, 50) &&
        baseline_median > 0 &&
        r.build_test_hours > 1.1 * baseline_median &&
        r.build_test_hours > baseline_p90;
      return { ...r, baseline_median, flagged };
    });
  }, [data, medianWindow]);

  const flaggedRows = useMemo(
    () => enriched.filter((r) => r.flagged),
    [enriched]
  );

  // Bounds of the full dataset, used to convert dataZoom percentages -> time.
  const [tMin, tMax] = useMemo(() => {
    return enriched.length
      ? [
          Date.parse(enriched[0].ts),
          Date.parse(enriched[enriched.length - 1].ts),
        ]
      : [0, 0];
  }, [enriched]);

  // Keep the option reference stable across zoom-driven re-renders
  // (visibleRange is deliberately NOT a dependency) so the chart stays
  // uncontrolled after mount and user zoom is preserved.
  const option = useMemo(() => {
    const rows = enriched;
    // Series name and legend entry must stay byte-identical or the legend toggle
    // breaks. Keep it static (the active window shows in the dropdown) so
    // changing the window doesn't reset the user's legend show/hide state.
    const baselineName = "build+test baseline (rolling median)";

    const toPoint = (r: EnrichedRow) => ({
      value: [r.ts, r.build_test_hours],
      sha: r.sha,
      wallclock_hours: r.wallclock_hours,
      longest_job_hours: r.longest_job_hours,
      build_test_hours: r.build_test_hours,
      baseline_median: r.baseline_median,
      crit_conclusion: r.crit_conclusion,
      commit_title: r.commit_title,
      land_time: r.land_time,
    });

    return {
      title: { text: "pull workflow build+test per trunk commit" },
      grid: { top: 72, right: 8, bottom: 72, left: 48 },
      legend: {
        top: 28,
        data: [
          "success",
          "failure",
          "cancelled",
          "flagged (anomaly)",
          baselineName,
        ],
      },
      xAxis: { type: "time" },
      yAxis: { type: "value", name: "Hours" },
      dataZoom: [
        {
          type: "inside",
          ...(focusStart && focusStop
            ? { startValue: focusStart, endValue: focusStop }
            : {}),
        },
        {
          type: "slider",
          ...(focusStart && focusStop
            ? { startValue: focusStart, endValue: focusStop }
            : {}),
        },
      ],
      tooltip: {
        trigger: "item",
        formatter: (params: any) => {
          const d = params?.data;
          if (d === undefined || d.sha === undefined) {
            return "";
          }
          const conclusion = d.crit_conclusion;
          const conclusionHtml =
            conclusion === "success"
              ? `<span style="opacity:0.7;">${conclusion}</span>`
              : `<span style="color:${
                  CONCLUSION_COLOR[conclusion] ?? "#8891a0"
                };font-weight:bold;">${conclusion}</span>`;
          const titleHtml = d.commit_title
            ? `${escapeHtml(truncateTitle(d.commit_title))}<br/>`
            : "";
          const landedHtml = d.land_time ? `landed: ${d.land_time}<br/>` : "";
          return (
            `<b>${d.sha.substring(0, 7)}</b><br/>` +
            titleHtml +
            `build+test: ${Number(d.build_test_hours).toFixed(2)} h<br/>` +
            `longest job: ${Number(d.longest_job_hours).toFixed(2)} h<br/>` +
            `wall-clock: ${Number(d.wallclock_hours).toFixed(2)} h<br/>` +
            `baseline: ${Number(d.baseline_median).toFixed(2)} h<br/>` +
            `conclusion: ${conclusionHtml}<br/>` +
            landedHtml +
            `<span style="color:${LINK_COLOR};font-weight:bold;">▸ click to open this commit on HUD</span>`
          );
        },
      },
      series: [
        // One large-mode series per conclusion for the non-flagged points:
        // large mode ignores per-point colors, so color must be series-level.
        ...(
          [
            { name: "success", opacity: 0.35 },
            { name: "failure", opacity: 0.55 },
            { name: "cancelled", opacity: 0.75 },
          ] as const
        ).map(({ name, opacity }) => ({
          name,
          type: "scatter",
          large: true,
          largeThreshold: 2000,
          progressive: 4000,
          symbolSize: 4,
          itemStyle: { color: CONCLUSION_COLOR[name], opacity },
          cursor: "pointer",
          z: 2,
          data: rows
            .filter((r) => !r.flagged && r.crit_conclusion === name)
            .map(toPoint),
        })),
        {
          name: baselineName,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1, opacity: 0.6 },
          z: 3,
          data: rows.map((r) => [r.ts, r.baseline_median]),
        },
        {
          // Small series, so per-point itemStyle works; no large mode here.
          name: "flagged (anomaly)",
          type: "scatter",
          symbol: "triangle",
          symbolSize: 11,
          cursor: "pointer",
          z: 5,
          data: flaggedRows.map((r) => ({
            ...toPoint(r),
            itemStyle: {
              color: CONCLUSION_COLOR[r.crit_conclusion] ?? "#8891a0",
              borderColor: darkMode ? "#eee" : "#333",
              borderWidth: 1,
            },
          })),
        },
      ],
    };
  }, [enriched, medianWindow, flaggedRows, darkMode, focusStart, focusStop]);

  // Stable onEvents identity: echarts-for-react disposes + reinits the chart when
  // the onEvents prop changes by reference, so an inline object (fresh each render)
  // would tear the chart down — and drop the zoom. Memoize it; only tMin/tMax are
  // captured (setVisibleRange is stable).
  const onEvents = useMemo(
    () => ({
      click: (p: any) => {
        const sha = p?.data?.sha;
        if (sha) {
          window.open(commitUrl(sha), "_blank");
        }
      },
      datazoom: (evt: any) => {
        const z = evt?.batch?.[0] ?? evt;
        let s = z?.startValue;
        let e = z?.endValue;
        if (s === undefined || e === undefined) {
          // Slider/inside zoom reports percentages; map them onto the data range.
          const startPct = z?.start ?? 0;
          const endPct = z?.end ?? 100;
          s = tMin + ((tMax - tMin) * startPct) / 100;
          e = tMin + ((tMax - tMin) * endPct) / 100;
        }
        setVisibleRange([Number(new Date(s)), Number(new Date(e))]);
      },
    }),
    [tMin, tMax]
  );

  if (data === undefined) {
    return <Skeleton variant="rectangular" height={chartHeight} />;
  }

  const inVisibleRange = (r: CommitRow) => {
    if (visibleRange === null) {
      return true;
    }
    const t = Date.parse(r.ts);
    return t >= visibleRange[0] && t <= visibleRange[1];
  };

  // Table follows the zoomed section (newest first).
  const visibleFlagged = flaggedRows.filter(inVisibleRange);
  const flaggedNewestFirst = [...visibleFlagged].reverse();
  const shownFlagged = flaggedNewestFirst.slice(0, MAX_FLAGGED_TABLE_ROWS);
  const hiddenFlaggedCount = flaggedNewestFirst.length - shownFlagged.length;

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <FormControl size="small" sx={{ mb: 1, minWidth: 220 }}>
        <InputLabel id="median-window-label">
          Rolling median window (commits)
        </InputLabel>
        <Select
          labelId="median-window-label"
          value={medianWindow}
          label="Rolling median window (commits)"
          onChange={(e) => setMedianWindow(Number(e.target.value))}
        >
          {MEDIAN_WINDOW_OPTIONS.map((w) => (
            <MenuItem key={w} value={w}>
              {w}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        option={option}
        style={{ height: chartHeight, width: "100%" }}
        notMerge={false}
        shouldSetOption={(prev: any, cur: any) => prev.option !== cur.option}
        onEvents={onEvents}
      />
      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        Flagged commits{visibleRange !== null ? " (current zoom window)" : ""}:{" "}
        {flaggedNewestFirst.length}
      </Typography>
      {flaggedNewestFirst.length === 0 ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          No flagged commits in this range.
        </Typography>
      ) : (
        <>
          <Table size="small" sx={{ mt: 1 }}>
            <TableHead>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell>Commit</TableCell>
                <TableCell>Title</TableCell>
                <TableCell align="right">build+test (h)</TableCell>
                <TableCell align="right">baseline (h)</TableCell>
                <TableCell align="right">Δ% over baseline</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shownFlagged.map((r) => (
                <TableRow key={`${r.sha}-${r.ts}`}>
                  <TableCell>{r.ts.substring(0, 10)}</TableCell>
                  <TableCell>
                    <a
                      href={commitUrl(r.sha)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: LINK_COLOR }}
                    >
                      {r.sha.substring(0, 7)}
                    </a>
                  </TableCell>
                  <TableCell
                    sx={{
                      maxWidth: 360,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={r.commit_title}
                  >
                    {r.commit_title}
                  </TableCell>
                  <TableCell align="right">
                    {Number(r.build_test_hours).toFixed(2)}
                  </TableCell>
                  <TableCell align="right">
                    {Number(r.baseline_median).toFixed(2)}
                  </TableCell>
                  <TableCell align="right">
                    {(
                      (r.build_test_hours / r.baseline_median - 1) *
                      100
                    ).toFixed(0)}
                    %
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {hiddenFlaggedCount > 0 && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              +{hiddenFlaggedCount} more
            </Typography>
          )}
        </>
      )}
    </Paper>
  );
}
