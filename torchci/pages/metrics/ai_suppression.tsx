import {
  Chip,
  Grid,
  Link,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  CLICKHOUSE_TIME_FORMAT,
  DEFAULT_TIME_RANGE,
  snapStopToGranularity,
  snapToGranularity,
} from "components/common/timeWindow";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { fetcher } from "lib/GeneralUtils";
import { TimeRangePicker } from "pages/metrics";
import { useState } from "react";
import useSWR from "swr";

dayjs.extend(utc);

// A revert this long after the merge still counts against it. Fixed rather than
// user-selectable so the cohort's rate and the baseline are always comparable.
const REVERT_WINDOW_DAYS = 7;
const REPO = "pytorch/pytorch";

// [name, url, verdict, confidence, summary, conclusion on merge commit,
//  conclusion on merge base]
type ClearedCheck = [string, string, string, number, string, string, string];

interface MergeRow {
  pr_number: number;
  title: string;
  author: string;
  merged_sha: string;
  merged_at: string | null;
  checks: ClearedCheck[];
  trunk_red: number;
  window_closed: number;
  reverted: number;
  ghfirst_reverted: number;
  revert_sha: string;
  reverted_at: string | null;
  reverter: string;
  revert_classification: string;
  attributed: number;
  merges_total: number;
  cleared_merges_total: number;
  cleared_checks_total: number;
  cleared_closed_total: number;
  cleared_reverted_total: number;
  cleared_attributed_total: number;
  cleared_trunk_red_total: number;
  other_closed_total: number;
  other_reverted_total: number;
}

const FAILED_CONCLUSIONS = ["failure", "timed_out"];

// The query returns no rows at all only when nothing landed in the window, so
// every count is a known zero rather than missing.
const ZERO_TOTALS = {
  merges_total: 0,
  cleared_merges_total: 0,
  cleared_checks_total: 0,
  cleared_closed_total: 0,
  cleared_reverted_total: 0,
  cleared_attributed_total: 0,
  cleared_trunk_red_total: 0,
  other_closed_total: 0,
  other_reverted_total: 0,
} as MergeRow;

function pct(numerator: number, denominator: number): string {
  return denominator > 0
    ? `${((100 * numerator) / denominator).toFixed(1)}%`
    : "-";
}

function Tile({
  title,
  value,
  detail,
  tooltip,
}: {
  title: string;
  value: string | number | undefined;
  detail?: string;
  tooltip: string;
}) {
  return (
    <Paper sx={{ p: 2, height: "100%", minHeight: 110 }} elevation={3}>
      <Tooltip title={tooltip} arrow>
        <Stack spacing={1} alignItems="center" justifyContent="center">
          <Typography
            variant="subtitle2"
            color="text.secondary"
            textAlign="center"
          >
            {title}
          </Typography>
          <Typography variant="h4" fontWeight="bold" textAlign="center">
            {value === undefined ? "-" : value}
          </Typography>
          {detail && (
            <Typography
              variant="caption"
              color="text.secondary"
              textAlign="center"
            >
              {detail}
            </Typography>
          )}
        </Stack>
      </Tooltip>
    </Paper>
  );
}

function Tiles({ totals }: { totals: MergeRow | undefined }) {
  const t = totals;
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
        <Tile
          title="AI-cleared merges"
          value={t?.cleared_merges_total}
          detail={
            t &&
            `${pct(t.cleared_merges_total, t.merges_total)} of ${
              t.merges_total
            } bot merges`
          }
          tooltip="Landed, non-force merges that would have been blocked without the AI: at least one failed check was cleared only by an advisor not_related verdict."
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
        <Tile
          title="Checks cleared"
          value={t?.cleared_checks_total}
          tooltip="Failed checks the AI cleared across those merges."
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
        <Tile
          title={`Reverted within ${REVERT_WINDOW_DAYS}d`}
          value={t && pct(t.cleared_reverted_total, t.cleared_closed_total)}
          detail={
            t &&
            `${t.cleared_reverted_total}/${
              t.cleared_closed_total
            } · baseline ${pct(
              t.other_reverted_total,
              t.other_closed_total
            )} (${t.other_reverted_total}/${t.other_closed_total})`
          }
          tooltip={`Share of AI-cleared merges reverted within ${REVERT_WINDOW_DAYS} days, beside the same rate for every other bot merge. Both count only merges whose ${REVERT_WINDOW_DAYS}-day window has closed, and neither counts -c ghfirst reverts. The baseline is an unadjusted comparison, not a target: the two populations differ in more than the AI's call.`}
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
        <Tile
          title="Attributed escapes"
          value={t?.cleared_attributed_total}
          tooltip="Reverts that plausibly came from a cleared signal: autorevert reverted on a job matching a cleared job, or a human reverted with -c ignoredsignal. This is the closest measure of an AI miss; other reverts are unattributed, not clean. Counted as soon as they happen, including merges whose revert window is still open."
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
        <Tile
          title="Newly red on trunk"
          value={t?.cleared_trunk_red_total}
          tooltip="Merges where a cleared job failed on the merge commit on main while it passed on the merge base. A leading indicator: it shows up hours before a revert, and also catches misses that were forward-fixed."
        />
      </Grid>
    </Grid>
  );
}

function WeeklyChart({
  rows,
  startTime,
  stopTime,
}: {
  rows: MergeRow[] | undefined;
  startTime: string;
  stopTime: string;
}) {
  const { darkMode } = useDarkMode();
  if (rows === undefined) {
    return <Skeleton variant="rectangular" height={360} />;
  }
  // [not reverted, reverted unattributed, reverted attributed] per week
  // (Sunday), with every week of the window present so quiet weeks show as 0.
  const weeks = new Map<string, [number, number, number]>();
  const lastWeek = dayjs.utc(stopTime).startOf("week");
  for (
    let week = dayjs.utc(startTime).startOf("week");
    !week.isAfter(lastWeek);
    week = week.add(1, "week")
  ) {
    weeks.set(week.format("YYYY-MM-DD"), [0, 0, 0]);
  }
  for (const row of rows) {
    const week = dayjs.utc(row.merged_at).startOf("week").format("YYYY-MM-DD");
    const counts = weeks.get(week) ?? [0, 0, 0];
    counts[row.attributed ? 2 : row.reverted ? 1 : 0] += 1;
    weeks.set(week, counts);
  }
  const labels = Array.from(weeks.keys()).sort();
  const series = (name: string, index: number) => ({
    name,
    type: "bar" as const,
    stack: "merges",
    data: labels.map((week) => weeks.get(week)![index]),
  });
  const options: EChartsOption = {
    title: { text: "AI-cleared merges per week" },
    tooltip: { trigger: "axis" },
    legend: { top: 30 },
    grid: { top: 80, right: 20, bottom: 40, left: 50 },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", minInterval: 1 },
    series: [
      series("Not reverted", 0),
      series("Reverted, unattributed", 1),
      series("Reverted, attributed", 2),
    ],
  };
  return (
    <Paper sx={{ p: 2, height: 380 }} elevation={3}>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}

function CheckChip({ check }: { check: ClearedCheck }) {
  const [name, url, verdict, confidence, summary, onMerge, onBase] = check;
  const trunk = onMerge
    ? `on main: ${onMerge} (merge base: ${onBase || "not run"})`
    : "not run on the merge commit";
  const newlyRed = FAILED_CONCLUSIONS.includes(onMerge) && onBase === "success";
  return (
    <Tooltip
      arrow
      title={
        <span>
          {verdict
            ? `${verdict} @ ${confidence.toFixed(2)}: ${summary}`
            : "No advisor verdict row found for this check."}
          <br />
          {trunk}
        </span>
      }
    >
      <Chip
        size="small"
        component="a"
        href={url}
        target="_blank"
        clickable
        color={newlyRed ? "error" : "default"}
        label={name}
        sx={{ maxWidth: 480 }}
      />
    </Tooltip>
  );
}

function revertLabel(row: MergeRow): string {
  if (!row.revert_sha) {
    return row.window_closed ? "no" : "no (window open)";
  }
  const by =
    row.reverter === "pytorch-auto-revert" ? "autorevert" : row.reverter;
  const cls = row.revert_classification ? `, ${row.revert_classification}` : "";
  const days = dayjs(row.reverted_at).diff(dayjs(row.merged_at), "hour") / 24;
  return `${by}${cls}, after ${days.toFixed(1)}d`;
}

function MergesTable({ rows }: { rows: MergeRow[] | undefined }) {
  if (rows === undefined) {
    return <Skeleton variant="rectangular" height={300} />;
  }
  if (rows.length === 0) {
    return (
      <Typography color="text.secondary">
        No AI-cleared merges in this window.
      </Typography>
    );
  }
  return (
    <TableContainer component={Paper} elevation={3}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>PR</TableCell>
            <TableCell>Merged (UTC)</TableCell>
            <TableCell>Cleared checks</TableCell>
            <TableCell>Reverted</TableCell>
            <TableCell>Attributed</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.merged_sha}>
              <TableCell sx={{ maxWidth: 360 }}>
                <Link
                  href={`https://github.com/${REPO}/pull/${row.pr_number}`}
                  target="_blank"
                >
                  #{row.pr_number}
                </Link>{" "}
                {row.title}
                <Typography variant="caption" display="block">
                  {row.author.split(" <")[0]}
                </Typography>
              </TableCell>
              <TableCell sx={{ whiteSpace: "nowrap" }}>
                {dayjs.utc(row.merged_at).format("YYYY-MM-DD HH:mm")}
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {row.checks.map((check) => (
                    <CheckChip key={check[0]} check={check} />
                  ))}
                </Stack>
              </TableCell>
              <TableCell>
                {row.revert_sha ? (
                  <Link
                    href={`https://github.com/${REPO}/commit/${row.revert_sha}`}
                    target="_blank"
                  >
                    {revertLabel(row)}
                  </Link>
                ) : (
                  revertLabel(row)
                )}
              </TableCell>
              <TableCell>{row.attributed ? "yes" : ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default function Page() {
  const [timeRange, setTimeRange] = useState(DEFAULT_TIME_RANGE);
  const [startTime, setStartTime] = useState(
    dayjs().subtract(DEFAULT_TIME_RANGE, "day")
  );
  const [stopTime, setStopTime] = useState(dayjs());

  // Snapped to the hour so the SWR key, and so the query, stays stable while
  // the picker re-derives "now".
  const params = {
    startTime: snapToGranularity(startTime, "hour").format(
      CLICKHOUSE_TIME_FORMAT
    ),
    stopTime: snapStopToGranularity(stopTime, "hour").format(
      CLICKHOUSE_TIME_FORMAT
    ),
    repo: REPO,
    revertWindowDays: REVERT_WINDOW_DAYS,
  };
  const url = `/api/clickhouse/ai_suppression_merges?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;
  const { data } = useSWR<MergeRow[]>(url, fetcher, {
    refreshInterval: 15 * 60 * 1000,
  });

  // The query always returns at least one row carrying the window totals; a
  // row with no merged_sha is only that carrier.
  const totals = data && (data[0] ?? ZERO_TOTALS);
  const rows = data?.filter((row) => row.merged_sha !== "");

  return (
    <Stack spacing={3}>
      <Typography fontSize="2rem" fontWeight="bold">
        AI Suppression Quality
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Merges that landed only because the AI advisor cleared their failures
        (Dr.CI <code>AI_NOT_RELATED</code>), and what happened to them next:
        reverted within {REVERT_WINDOW_DAYS} days, the revert attributable to a
        cleared signal, or a cleared job newly failing on trunk.
      </Typography>
      <TimeRangePicker
        startTime={startTime}
        setStartTime={setStartTime}
        stopTime={stopTime}
        setStopTime={setStopTime}
        timeRange={timeRange}
        setTimeRange={setTimeRange}
      />
      <Tiles totals={totals} />
      {totals !== undefined &&
        rows !== undefined &&
        totals.cleared_merges_total > rows.length && (
          <Typography variant="body2" color="warning.main">
            The chart and table show the {rows.length} most recent of{" "}
            {totals.cleared_merges_total} AI-cleared merges; the tiles cover all
            of them. Narrow the time range to see the rest.
          </Typography>
        )}
      <WeeklyChart
        rows={rows}
        startTime={params.startTime}
        stopTime={params.stopTime}
      />
      <MergesTable rows={rows} />
    </Stack>
  );
}
