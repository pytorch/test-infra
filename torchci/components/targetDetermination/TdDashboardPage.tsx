/**
 * Target Determination dashboard: surfaces TD's realized wall-time impact by
 * comparing pull/trunk timing on a PR's pre-merge head (the TD subset) vs the
 * squashed commit that landed on trunk (the full suite).
 *
 * Data comes from the saved query `td_pr_vs_merge_times` (one row per landed
 * PR, columns pull_pr_s / pull_merge_s / trunk_pr_s / trunk_merge_s). The
 * percentile bar chart aggregates the selected series across the window
 * CLIENT-SIDE over those same rows, and each table row shows its own four times
 * as inline CSS bars (lightweight -- no per-row chart instance) so a row is
 * easy to parse at a glance.
 */
import {
  Box,
  Chip,
  Divider,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import LoadingPage from "components/common/LoadingPage";
import MultiSelectPicker from "components/common/MultiSelectPicker";
import { ChartPaper } from "components/metrics/vllm/chartUtils";
import {
  COLOR_SUCCESS,
  COLOR_WARNING,
} from "components/metrics/vllm/constants";
import { UMDenseDropdown } from "components/uiModules/UMDenseComponents";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { useMemo, useState } from "react";

dayjs.extend(utc);

const REPO = "pytorch/pytorch";
const REF = "refs/heads/main";
const OWNER = "pytorch";
const PROJECT = "pytorch";
const TIME_FMT = "YYYY-MM-DD HH:mm:ss";

type TimeRow = {
  pr_num: number;
  pr_head: string;
  merge_sha: string;
  merge_time: string;
  title: string;
  author: string;
  merge_type: string; // clean | force | ignore
  trunk_coverage: string; // green | failure | cancelled | absent | ...
  // Seconds. A LEFT JOIN miss (run absent for that commit/workflow) comes back as
  // 0, never null (non-nullable aggregate); fmtDurS renders 0 as "–".
  pull_pr_s: number;
  pull_merge_s: number;
  trunk_pr_s: number;
  trunk_merge_s: number;
};

// The four wall-time series. anchor="pr" = the PR's pre-merge head (Target
// Determination subset); anchor="merged" = the squashed commit on trunk (full
// suite). Ordered so each workflow's PR-vs-merged pair sits adjacent.
type SeriesKey = "pull_pr_s" | "pull_merge_s" | "trunk_pr_s" | "trunk_merge_s";
type Series = {
  key: SeriesKey;
  label: string;
  short: string;
  anchor: "pr" | "merged";
};
const SERIES: Series[] = [
  { key: "pull_pr_s", label: "PR / pull", short: "PR·pull", anchor: "pr" },
  {
    key: "pull_merge_s",
    label: "merged / pull",
    short: "mg·pull",
    anchor: "merged",
  },
  { key: "trunk_pr_s", label: "PR / trunk", short: "PR·trunk", anchor: "pr" },
  {
    key: "trunk_merge_s",
    label: "merged / trunk",
    short: "mg·trunk",
    anchor: "merged",
  },
];
const ALL_LABELS = SERIES.map((s) => s.label);

// Bar lengths are capped at 8h so the long tail of gap-inflated spans (a late
// straggler can stretch a run's min->max window to 20h+ even when every job ran
// <2h) doesn't crush the scale. The true value is always shown in the label.
const CAP_SEC = 8 * 3600;

function seriesColor(anchor: "pr" | "merged"): string {
  return anchor === "pr" ? COLOR_SUCCESS : COLOR_WARNING;
}

const RANGE_OPTIONS = [
  { value: "1", displayName: "Last 1 Day" },
  { value: "3", displayName: "Last 3 Days" },
  { value: "7", displayName: "Last 7 Days" },
  { value: "14", displayName: "Last 14 Days" },
  { value: "30", displayName: "Last 30 Days" },
  { value: "90", displayName: "Last 90 Days" },
];

const PCT_OPTIONS = [
  { value: "avg", displayName: "avg" },
  { value: "p50", displayName: "p50" },
  { value: "p90", displayName: "p90" },
  { value: "p95", displayName: "p95" },
  { value: "p99", displayName: "p99" },
];
const PCT_FRAC: Record<string, number> = {
  p50: 0.5,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99,
};

const MERGE_TYPE_COLOR: Record<string, "default" | "error" | "warning"> = {
  clean: "default",
  force: "error",
  ignore: "warning",
};

function fmtDurS(s: number | null | undefined): string {
  if (s == null || s <= 0) return "–";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// Linear-interpolated quantile over an ascending-sorted array (matches
// ClickHouse quantile()). q in [0, 1].
function quantileSorted(asc: number[], q: number): number {
  if (asc.length === 1) return asc[0];
  const pos = (asc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = asc[base + 1];
  return next === undefined ? asc[base] : asc[base] + rest * (next - asc[base]);
}

function aggregate(values: number[], pct: string): number | null {
  const v = values.filter((x) => x != null && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (pct === "avg") return v.reduce((s, x) => s + x, 0) / v.length;
  return quantileSorted(v, PCT_FRAC[pct] ?? 0.5);
}

export function TdDashboardPage() {
  const { darkMode } = useDarkMode();

  // Time range is a preset-days dropdown (matches the /metrics style). start/end
  // are held as state so they only change on selection -> stable SWR key.
  const [rangeDays, setRangeDays] = useState<string>("7");
  const [start, setStart] = useState<Dayjs>(
    dayjs().utc().startOf("day").subtract(6, "day")
  );
  const [end, setEnd] = useState<Dayjs>(dayjs().utc().endOf("day"));
  const [percentile, setPercentile] = useState<string>("p50");
  const [selected, setSelected] = useState<string[]>(ALL_LABELS);

  function handleRange(v: string) {
    setRangeDays(v);
    const days = parseInt(v, 10);
    setStart(
      dayjs()
        .utc()
        .startOf("day")
        .subtract(days - 1, "day")
    );
    setEnd(dayjs().utc().endOf("day"));
  }

  const params = {
    repo: REPO,
    ref: REF,
    owner: OWNER,
    project: PROJECT,
    startTime: start.format(TIME_FMT),
    stopTime: end.format(TIME_FMT),
  };

  const {
    data: times,
    error,
    isLoading,
  } = useClickHouseAPIImmutable<TimeRow>("td_pr_vs_merge_times", params);

  const activeSeries = useMemo(
    () => SERIES.filter((s) => selected.includes(s.label)),
    [selected]
  );

  // Aggregate the active series to the chosen percentile, client-side over the
  // per-merge rows already fetched for the table.
  const bars = useMemo(() => {
    const rows = times ?? [];
    return activeSeries.map((s) => {
      const vals = rows
        .map((r) => r[s.key])
        .filter((x): x is number => x != null);
      return {
        label: s.label,
        seconds: aggregate(vals, percentile),
        n: vals.filter((x) => x > 0).length,
        color: seriesColor(s.anchor),
      };
    });
  }, [times, activeSeries, percentile]);

  const chartOption = useMemo(
    () => ({
      grid: { left: 120, right: 72, top: 16, bottom: 36 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: any) => {
          const p = Array.isArray(ps) ? ps[0] : ps;
          const b = bars[p.dataIndex];
          if (!b) return "";
          const capped =
            (b.seconds ?? 0) > CAP_SEC
              ? ` <span style="opacity:.6">(bar capped at 8h)</span>`
              : "";
          return `${b.label}<br/><b>${fmtDurS(
            b.seconds
          )}</b>${capped} &nbsp;<span style="opacity:.6">n=${b.n}</span>`;
        },
      },
      xAxis: {
        type: "value",
        name: "wall time",
        nameLocation: "middle",
        nameGap: 28,
        axisLabel: { formatter: (v: number) => `${Math.round(v / 60)}m` },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: bars.map((b) => b.label),
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 36,
          data: bars.map((b) => ({
            value: Math.min(b.seconds ?? 0, CAP_SEC), // bar length clamped
            itemStyle: { color: b.color },
          })),
          label: {
            show: true,
            position: "right",
            // Show the TRUE value even when the bar is clamped.
            formatter: (p: any) => fmtDurS(bars[p.dataIndex]?.seconds),
          },
        },
      ],
    }),
    [bars]
  );

  const chartHeight = 96 + Math.max(bars.length, 1) * 48;

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        useFlexGap
        flexWrap="wrap"
      >
        <Typography variant="h4" fontWeight="bold">
          Target Determination
        </Typography>
        <UMDenseDropdown
          label="Time Range"
          dtype={rangeDays}
          setDType={handleRange}
          dtypes={RANGE_OPTIONS}
          sx={{ minWidth: 140 }}
        />
        <UMDenseDropdown
          label="Percentile"
          dtype={percentile}
          setDType={setPercentile}
          dtypes={PCT_OPTIONS}
          sx={{ minWidth: 110 }}
        />
        <MultiSelectPicker
          label="Series"
          initialSelected={ALL_LABELS}
          options={ALL_LABELS}
          onSelectChanged={setSelected}
          renderValue={(sel) =>
            sel.length === ALL_LABELS.length ? "All series" : sel.join(", ")
          }
          style={{ minWidth: 150 }}
        />
      </Stack>

      <Typography variant="body2">
        <code>pull</code>/<code>trunk</code> run duration on the PR&apos;s
        pre-merge head (the Target-Determination subset) vs the squashed commit
        on trunk (the full suite), for landed PRs on{" "}
        <code>
          {REPO}@{REF.replace("refs/heads/", "")}
        </code>
        . Duration = a run&apos;s earliest job creation → latest job completion
        (longest run per commit).
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center">
        <Chip
          size="small"
          label="PR-time (TD subset)"
          sx={{ bgcolor: COLOR_SUCCESS, color: "#000" }}
        />
        <Chip
          size="small"
          label="merged (full suite)"
          sx={{ bgcolor: COLOR_WARNING, color: "#000" }}
        />
      </Stack>

      {error ? (
        <Typography color="error">Error loading data: {`${error}`}</Typography>
      ) : isLoading || !times ? (
        <LoadingPage />
      ) : (
        <>
          <Box sx={{ height: chartHeight }}>
            <ChartPaper
              darkMode={darkMode}
              option={chartOption}
              tooltip="Run duration = earliest job creation → latest job completion over the commit's longest run (the commit-page Gantt formula, computed from jobs). Uses job created_at (not started_at) so rerun timestamp glitches don't inflate it, and reads job completions so in-progress runs aren't understated. Aggregated across all merges at the selected percentile; bar length capped at 8h (label shows the true value)."
            />
          </Box>

          <Divider />

          <Typography variant="h6">
            Matched commits{" "}
            <Typography
              component="span"
              variant="caption"
              sx={{ opacity: 0.7 }}
            >
              ({times.length} in window)
            </Typography>
          </Typography>
          <TimingTable rows={times} series={activeSeries} />
        </>
      )}
    </Stack>
  );
}

// Per-row inline bars: each of the (active) four times as a CSS bar, scaled to a
// shared max across the whole table so rows are comparable. Green = PR-time,
// orange = merged.
function RowBars({
  row,
  series,
  maxSec,
}: {
  row: TimeRow;
  series: Series[];
  maxSec: number;
}) {
  return (
    <Box sx={{ minWidth: 200 }}>
      {series.map((s) => {
        const v = row[s.key];
        const pct =
          v && maxSec > 0
            ? Math.min(Math.max((v / maxSec) * 100, 1.5), 100)
            : 0;
        return (
          <Box
            key={s.key}
            title={`${s.label}: ${fmtDurS(v)}`}
            sx={{ display: "flex", alignItems: "center", gap: 0.5, my: 0.2 }}
          >
            <Box
              sx={{
                width: 52,
                fontSize: "0.7rem",
                opacity: 0.65,
                textAlign: "right",
                whiteSpace: "nowrap",
              }}
            >
              {s.short}
            </Box>
            <Box
              sx={{
                flex: 1,
                height: 9,
                bgcolor: "action.hover",
                borderRadius: 0.5,
                overflow: "hidden",
              }}
            >
              <Box
                sx={{
                  width: `${pct}%`,
                  height: "100%",
                  bgcolor: seriesColor(s.anchor),
                  borderRadius: 0.5,
                }}
              />
            </Box>
            <Box
              sx={{
                width: 44,
                fontSize: "0.7rem",
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fmtDurS(v)}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// Per-merge detail table: the PR<->trunk mapping plus an inline bar chart of the
// four wall times per row.
function TimingTable({ rows, series }: { rows: TimeRow[]; series: Series[] }) {
  // Shared bar scale = smaller of the table-wide max and the 8h cap, so a single
  // outlier row can't crush every other bar and nothing renders past 8h.
  const maxSec = useMemo(() => {
    let m = 0;
    for (const r of rows) {
      for (const s of series) {
        const v = r[s.key];
        if (v && v > m) m = v;
      }
    }
    return Math.min(m, CAP_SEC);
  }, [rows, series]);

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>PR</TableCell>
            <TableCell>Merged commit</TableCell>
            <TableCell>PR commit</TableCell>
            <TableCell>Type</TableCell>
            <TableCell sx={{ width: 280 }}>Times</TableCell>
            <TableCell>Title</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.pr_num}-${row.merge_sha}`} hover>
              <TableCell>
                <Link
                  href={`https://github.com/${REPO}/pull/${row.pr_num}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{row.pr_num}
                </Link>
              </TableCell>
              <TableCell>
                <Link
                  href={`/${REPO}/commit/${row.merge_sha}`}
                  sx={{ fontFamily: "monospace" }}
                >
                  {row.merge_sha.slice(0, 9)}
                </Link>
              </TableCell>
              <TableCell>
                {row.pr_head ? (
                  <Link
                    href={`/${REPO}/commit/${row.pr_head}`}
                    sx={{ fontFamily: "monospace" }}
                  >
                    {row.pr_head.slice(0, 9)}
                  </Link>
                ) : (
                  "–"
                )}
              </TableCell>
              <TableCell>
                <Chip
                  size="small"
                  label={row.merge_type}
                  color={MERGE_TYPE_COLOR[row.merge_type] ?? "default"}
                  variant={row.merge_type === "clean" ? "outlined" : "filled"}
                />
              </TableCell>
              <TableCell sx={{ width: 280 }}>
                <RowBars row={row} series={series} maxSec={maxSec} />
              </TableCell>
              <TableCell sx={{ maxWidth: 420 }}>
                <Box
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={row.title}
                >
                  {row.title}
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
