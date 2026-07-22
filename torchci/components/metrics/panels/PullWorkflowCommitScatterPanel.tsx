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

function commitUrl(sha: string): string {
  return `https://hud.pytorch.org/pytorch/pytorch/commit/${sha}`;
}

export default function PullWorkflowCommitScatterPanel({
  startTime,
  stopTime,
}: {
  startTime: string;
  stopTime: string;
}) {
  const { darkMode } = useDarkMode();
  const { data } = useClickHouseAPIImmutable<CommitRow>(
    "pull_workflow_duration_per_commit_detail",
    { startTime, stopTime }
  );

  if (data === undefined) {
    return <Skeleton variant="rectangular" height="100%" />;
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
    dataZoom: [{ type: "inside" }, { type: "slider" }],
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
          `<span style="font-size:11px;opacity:0.8;">click to open commit</span>`
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

  const flaggedNewestFirst = [...flaggedRows].reverse();
  const shownFlagged = flaggedNewestFirst.slice(0, MAX_FLAGGED_TABLE_ROWS);
  const hiddenFlaggedCount = flaggedNewestFirst.length - shownFlagged.length;

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        option={option}
        style={{ height: 320, width: "100%" }}
        onEvents={{
          click: (p: any) => {
            const sha = p?.data?.sha;
            if (sha) {
              window.open(commitUrl(sha), "_blank");
            }
          },
        }}
      />
      {flaggedNewestFirst.length === 0 ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          No flagged commits in range.
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
                    <a href={commitUrl(r.sha)} target="_blank" rel="noreferrer">
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
