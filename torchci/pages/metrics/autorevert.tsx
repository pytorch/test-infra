import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Grid,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { TimeRangePicker } from "pages/metrics";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { fetcher } from "lib/GeneralUtils";
import { useState } from "react";
import useSWR from "swr";

// Viable/strict workflows that block merges - these are the default selection
const VIABLE_STRICT_WORKFLOWS = ["Lint", "pull", "trunk", "linux-aarch64"];
const MIN_RED_COMMITS = 2;
const MIN_GREEN_COMMITS = 2;

function ScalarMetric({
  title,
  value,
  tooltip,
  color,
}: {
  title: string;
  value: string | number | undefined;
  tooltip?: string;
  color?: string;
}) {
  return (
    <Paper sx={{ p: 2, height: "100%", minHeight: 100 }} elevation={3}>
      <Tooltip title={tooltip || ""} arrow>
        <Stack spacing={1} alignItems="center" justifyContent="center" height="100%">
          <Typography variant="subtitle2" color="text.secondary" textAlign="center">
            {title}
          </Typography>
          <Typography
            variant="h4"
            fontWeight="bold"
            color={color || "text.primary"}
            textAlign="center"
          >
            {value === undefined ? "-" : value}
          </Typography>
        </Stack>
      </Tooltip>
    </Paper>
  );
}

function WeeklyTrendChart({ data }: { data: any[] | undefined }) {
  const { darkMode } = useDarkMode();

  if (data === undefined) {
    return <Skeleton variant="rectangular" height={400} />;
  }

  const options: EChartsOption = {
    title: {
      text: "Weekly Autorevert Metrics",
      subtext: "Signal recovery events with attribution",
    },
    grid: { top: 80, right: 120, bottom: 60, left: 60 },
    xAxis: {
      type: "category",
      data: data.map((d) => d.week),
      axisLabel: { rotate: 45 },
    },
    yAxis: [
      {
        type: "value",
        name: "Count",
        position: "left",
      },
      {
        type: "value",
        name: "Rate %",
        position: "right",
        max: 100,
      },
    ],
    legend: {
      data: [
        "Autorevert Recoveries",
        "Human Revert Recoveries",
        "Non-Revert Recoveries",
        "Autorevert Rate %",
      ],
      top: 30,
    },
    tooltip: {
      trigger: "axis",
    },
    series: [
      {
        name: "Autorevert Recoveries",
        type: "bar",
        stack: "recoveries",
        data: data.map((d) => d.autorevert_recoveries),
        itemStyle: { color: "#3ba272" },
      },
      {
        name: "Human Revert Recoveries",
        type: "bar",
        stack: "recoveries",
        data: data.map((d) => d.human_revert_recoveries),
        itemStyle: { color: "#ed6c02" },  // MUI warning color (yellow/orange)
      },
      {
        name: "Non-Revert Recoveries",
        type: "bar",
        stack: "recoveries",
        data: data.map((d) => d.non_revert_recoveries),
        itemStyle: { color: "#8c8c8c" },
      },
      {
        name: "Autorevert Rate %",
        type: "line",
        yAxisIndex: 1,
        data: data.map((d) => d.autorevert_rate),
        itemStyle: { color: "#5470c6" },
        lineStyle: { width: 2 },
      },
    ],
  };

  return (
    <Paper sx={{ p: 2, height: 450 }} elevation={3}>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}

function SignificantRevertsTable({ data }: { data: any[] | undefined }) {
  if (data === undefined) {
    return <Skeleton variant="rectangular" height={400} />;
  }

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Typography variant="h6" sx={{ mb: 2 }}>
        Significant Reverts ({data.length} unique reverts)
      </Typography>
      <TableContainer sx={{ maxHeight: 500 }}>
        <Table stickyHeader size="small">
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Signals Fixed</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Max Red Streak</TableCell>
              <TableCell>Recovery SHA</TableCell>
              <TableCell>Reverted PR</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.map((row, idx) => (
              <TableRow key={idx}>
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  {dayjs(row.recovery_time).format("YYYY-MM-DD HH:mm")}
                </TableCell>
                <TableCell sx={{ maxWidth: 300 }}>
                  <Tooltip
                    title={
                      <Box sx={{ maxHeight: 300, overflow: "auto" }}>
                        {row.signal_keys?.map((sig: string, i: number) => (
                          <div key={i}>{sig}</div>
                        ))}
                      </Box>
                    }
                  >
                    <span>
                      {row.signals_fixed} signal{row.signals_fixed !== 1 ? "s" : ""}
                    </span>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <Chip
                    label={row.recovery_type === "autorevert_recovery" ? "Autorevert" : "Human"}
                    size="small"
                    sx={{
                      backgroundColor: row.recovery_type === "autorevert_recovery" ? "#3ba272" : "#ed6c02",
                      color: "white",
                    }}
                  />
                </TableCell>
                <TableCell>{row.max_red_streak_length}</TableCell>
                <TableCell>
                  <a
                    href={`https://github.com/pytorch/pytorch/commit/${row.recovery_sha}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {row.recovery_sha?.substring(0, 7)}
                  </a>
                </TableCell>
                <TableCell>
                  {row.reverted_pr_numbers?.length > 0 ? (
                    row.reverted_pr_numbers.map((pr: string, i: number) => (
                      <a
                        key={i}
                        href={`https://github.com/pytorch/pytorch/pull/${pr}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ marginRight: 4 }}
                      >
                        #{pr}
                      </a>
                    ))
                  ) : (
                    "-"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default function AutorevertMetricsPage() {
  const [startTime, setStartTime] = useState(dayjs().subtract(90, "day"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(90);
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>(VIABLE_STRICT_WORKFLOWS);

  // Fetch available workflows
  const workflowsUrl = `/api/clickhouse/autorevert_workflows?parameters=${encodeURIComponent(
    JSON.stringify({})
  )}`;
  const { data: availableWorkflows } = useSWR<{ workflow_name: string; run_count: number }[]>(
    workflowsUrl,
    fetcher
  );

  const workflowOptions = availableWorkflows?.map((w) => w.workflow_name) || VIABLE_STRICT_WORKFLOWS;

  const timeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    workflowNames: selectedWorkflows,
    minRedCommits: MIN_RED_COMMITS,
    minGreenCommits: MIN_GREEN_COMMITS,
  };

  const weeklyUrl = `/api/clickhouse/autorevert_weekly_metrics?parameters=${encodeURIComponent(
    JSON.stringify(timeParams)
  )}`;

  const revertsUrl = `/api/clickhouse/autorevert_significant_reverts?parameters=${encodeURIComponent(
    JSON.stringify(timeParams)
  )}`;

  const { data: weeklyData } = useSWR(weeklyUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
  });

  const { data: revertsData } = useSWR(revertsUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
  });

  // Calculate summary metrics from weekly data
  const totalRevertRecoveries = weeklyData?.reduce(
    (sum: number, d: any) => sum + d.total_revert_recoveries,
    0
  );
  const totalAutorevertRecoveries = weeklyData?.reduce(
    (sum: number, d: any) => sum + d.autorevert_recoveries,
    0
  );
  const totalHumanRevertRecoveries = weeklyData?.reduce(
    (sum: number, d: any) => sum + d.human_revert_recoveries,
    0
  );
  const overallAutorevertRate =
    totalRevertRecoveries > 0
      ? ((totalAutorevertRecoveries / totalRevertRecoveries) * 100).toFixed(1) + "%"
      : "-";

  return (
    <Stack spacing={3} sx={{ p: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        <Typography variant="h4" fontWeight="bold">
          Autorevert Metrics
        </Typography>
        <Chip label="BETA" color="warning" size="small" />
      </Box>

      <Typography variant="body2" color="text.secondary">
        Tracks autorevert system performance by analyzing signal recovery events. A signal recovery
        occurs when a job group transitions from 2+ consecutive red commits to 2+ green commits.
        Reverts are attributed to autorevert vs human based on matching with autorevert action logs.
      </Typography>

      <Box sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Box>

      <Box sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Autocomplete
          multiple
          size="small"
          options={workflowOptions}
          value={selectedWorkflows}
          onChange={(_, newValue) => setSelectedWorkflows(newValue)}
          renderInput={(params) => (
            <TextField {...params} label="Workflows" placeholder="Select workflows" />
          )}
          sx={{ minWidth: 400, maxWidth: 600 }}
          limitTags={3}
        />
        <Button
          variant="outlined"
          size="small"
          onClick={() => setSelectedWorkflows(VIABLE_STRICT_WORKFLOWS)}
        >
          Viable/Strict Only
        </Button>
        <Button
          variant="outlined"
          size="small"
          onClick={() => setSelectedWorkflows(workflowOptions)}
        >
          All Workflows
        </Button>
      </Box>

      {/* Summary Metrics */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, sm: 3 }}>
          <ScalarMetric
            title="Total Revert Recoveries"
            value={totalRevertRecoveries}
            tooltip="Total signal recovery events where the recovery was via a revert commit"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <ScalarMetric
            title="Autorevert Recoveries"
            value={totalAutorevertRecoveries}
            tooltip="Signal recoveries triggered by the autorevert system (True Positives)"
            color="#3ba272"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <ScalarMetric
            title="Human Revert Recoveries"
            value={totalHumanRevertRecoveries}
            tooltip="Signal recoveries from human-initiated reverts (potential False Negatives - should autorevert have caught these?)"
            color="#ed6c02"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <ScalarMetric
            title="Autorevert Rate"
            value={overallAutorevertRate}
            tooltip="Percentage of revert recoveries that were triggered by autorevert"
            color="#5470c6"
          />
        </Grid>
      </Grid>

      {/* Weekly Trend Chart */}
      <WeeklyTrendChart data={weeklyData} />

      {/* Significant Reverts Table */}
      <SignificantRevertsTable data={revertsData} />
    </Stack>
  );
}
