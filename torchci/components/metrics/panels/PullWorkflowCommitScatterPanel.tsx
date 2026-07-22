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
import { useEffect, useMemo, useState } from "react";

type CommitRow = {
  ts: string;
  sha: string;
  wallclock_hours: number;
  longest_job_hours: number;
  build_test_hours: number;
  baseline_median: number;
  flagged: number;
  crit_conclusion: "success" | "failure" | "cancelled";
};

const MAX_FLAGGED_TABLE_ROWS = 50;
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
  // router.query.focus is undefined until Next hydrates, so the useState seed
  // above can miss it; re-sync the table window when the focus props arrive or
  // change. Fires only on focus-prop changes, not on user zoom (which updates
  // visibleRange directly), so it doesn't fight manual zooming.
  useEffect(() => {
    if (focusStart && focusStop) {
      setVisibleRange([Date.parse(focusStart), Date.parse(focusStop)]);
    }
  }, [focusStart, focusStop]);

  const flaggedRows = useMemo(
    () => (data ? data.filter((r) => Number(r.flagged) === 1) : []),
    [data]
  );

  // Bounds of the full dataset, used to convert dataZoom percentages -> time.
  const [tMin, tMax] = useMemo(() => {
    const rows = data ?? [];
    return rows.length
      ? [Date.parse(rows[0].ts), Date.parse(rows[rows.length - 1].ts)]
      : [0, 0];
  }, [data]);

  // Keep the option reference stable across zoom-driven re-renders
  // (visibleRange is deliberately NOT a dependency) so the chart stays
  // uncontrolled after mount and user zoom is preserved.
  const option = useMemo(() => {
    const rows = data ?? [];

    const toPoint = (r: CommitRow) => ({
      value: [r.ts, r.build_test_hours],
      sha: r.sha,
      wallclock_hours: r.wallclock_hours,
      longest_job_hours: r.longest_job_hours,
      build_test_hours: r.build_test_hours,
      baseline_median: r.baseline_median,
      crit_conclusion: r.crit_conclusion,
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
          const conclusion = d.crit_conclusion;
          const conclusionHtml =
            conclusion === "success"
              ? `<span style="opacity:0.7;">${conclusion}</span>`
              : `<span style="color:${
                  CONCLUSION_COLOR[conclusion] ?? "#8891a0"
                };font-weight:bold;">${conclusion}</span>`;
          return (
            `<b>${d.sha.substring(0, 7)}</b><br/>` +
            `build+test: ${Number(d.build_test_hours).toFixed(2)} h<br/>` +
            `longest job: ${Number(d.longest_job_hours).toFixed(2)} h<br/>` +
            `wall-clock: ${Number(d.wallclock_hours).toFixed(2)} h<br/>` +
            `baseline: ${Number(d.baseline_median).toFixed(2)} h<br/>` +
            `conclusion: ${conclusionHtml}<br/>` +
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
            .filter(
              (r) => Number(r.flagged) !== 1 && r.crit_conclusion === name
            )
            .map(toPoint),
        })),
        {
          name: "build+test baseline (rolling median)",
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
  }, [data, flaggedRows, darkMode, focusStart, focusStop]);

  if (data === undefined) {
    return <Skeleton variant="rectangular" height={chartHeight} />;
  }

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
        shouldSetOption={(prev: any, cur: any) => prev.option !== cur.option}
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
