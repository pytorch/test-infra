import {
  Paper,
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
import { useState } from "react";

type CommitRow = {
  ts: string;
  sha: string;
  wallclock_hours: number;
  longest_job_hours: number;
  build_test_hours: number;
  baseline_median: number;
  flagged: number;
};

const MAX_FLAGGED_TABLE_ROWS = 50;
const LINK_COLOR = "#4493f8";

function commitUrl(sha: string): string {
  return `https://hud.pytorch.org/pytorch/pytorch/commit/${sha}`;
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
  // Time window currently visible on the x-axis (ms epoch). null = full range.
  // Seed it from the pre-zoom focus so the table matches the initial view.
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(
    focusStart && focusStop
      ? [Date.parse(focusStart), Date.parse(focusStop)]
      : null
  );

  if (data === undefined) {
    return <Skeleton variant="rectangular" height={chartHeight} />;
  }

  const toPoint = (r: CommitRow) => ({
    value: [r.ts, r.build_test_hours],
    sha: r.sha,
    wallclock_hours: r.wallclock_hours,
    longest_job_hours: r.longest_job_hours,
    build_test_hours: r.build_test_hours,
    baseline_median: r.baseline_median,
  });

  const flaggedRows = data.filter((r) => Number(r.flagged) === 1);

  // Bounds of the full dataset, used to convert dataZoom percentages -> time.
  const tMin = data.length ? Date.parse(data[0].ts) : 0;
  const tMax = data.length ? Date.parse(data[data.length - 1].ts) : 0;

  const onDataZoom = (evt: any) => {
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
  };

  const inVisibleRange = (r: CommitRow) => {
    if (visibleRange === null) {
      return true;
    }
    const t = Date.parse(r.ts);
    return t >= visibleRange[0] && t <= visibleRange[1];
  };

  const option = {
    title: { text: "pull workflow build+test per trunk commit" },
    grid: { top: 72, right: 8, bottom: 72, left: 48 },
    legend: {
      top: 28,
      data: [
        "build+test (per commit)",
        "flagged (>10% over baseline & > p90)",
        "build+test baseline (rolling median)",
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
        return (
          `<b>${d.sha.substring(0, 7)}</b><br/>` +
          `build+test: ${Number(d.build_test_hours).toFixed(2)} h<br/>` +
          `longest job: ${Number(d.longest_job_hours).toFixed(2)} h<br/>` +
          `wall-clock: ${Number(d.wallclock_hours).toFixed(2)} h<br/>` +
          `baseline: ${Number(d.baseline_median).toFixed(2)} h<br/>` +
          `<span style="color:${LINK_COLOR};font-weight:bold;">▸ click to open this commit on HUD</span>`
        );
      },
    },
    series: [
      {
        name: "build+test (per commit)",
        type: "scatter",
        large: true,
        largeThreshold: 2000,
        progressive: 4000,
        symbolSize: 4,
        itemStyle: { color: "#8891a0", opacity: 0.35 },
        cursor: "pointer",
        z: 2,
        data: data.map(toPoint),
      },
      {
        name: "build+test baseline (rolling median)",
        type: "line",
        showSymbol: false,
        lineStyle: { width: 1, opacity: 0.6 },
        z: 3,
        data: data.map((r) => [r.ts, r.baseline_median]),
      },
      {
        name: "flagged (>10% over baseline & > p90)",
        type: "scatter",
        symbol: "triangle",
        symbolSize: 10,
        itemStyle: { color: "#e4572e" },
        cursor: "pointer",
        z: 5,
        data: flaggedRows.map(toPoint),
      },
    ],
  };

  // Table follows the zoomed section (newest first).
  const visibleFlagged = flaggedRows.filter(inVisibleRange);
  const flaggedNewestFirst = [...visibleFlagged].reverse();
  const shownFlagged = flaggedNewestFirst.slice(0, MAX_FLAGGED_TABLE_ROWS);
  const hiddenFlaggedCount = flaggedNewestFirst.length - shownFlagged.length;

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        option={option}
        style={{ height: chartHeight, width: "100%" }}
        notMerge={false}
        onEvents={{
          click: (p: any) => {
            const sha = p?.data?.sha;
            if (sha) {
              window.open(commitUrl(sha), "_blank");
            }
          },
          datazoom: onDataZoom,
        }}
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
                <TableCell align="right">build+test (h)</TableCell>
                <TableCell align="right">baseline (h)</TableCell>
                <TableCell align="right">Δ% over baseline</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shownFlagged.map((r) => (
                <TableRow key={r.sha}>
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
