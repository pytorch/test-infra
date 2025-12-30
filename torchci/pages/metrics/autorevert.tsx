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
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { fetcher } from "lib/GeneralUtils";
import { TimeRangePicker } from "pages/metrics";
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
        <Stack
          spacing={1}
          alignItems="center"
          justifyContent="center"
          height="100%"
        >
          <Typography
            variant="subtitle2"
            color="text.secondary"
            textAlign="center"
          >
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

// Legend component explaining TP/FN/FP
function MetricsLegend() {
  return (
    <Paper sx={{ p: 2, mb: 2 }} elevation={1}>
      <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: "bold" }}>
        Metrics Legend
      </Typography>
      <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
        <Tooltip title="Autoreverts that were correct: either fixed a signal OR verified via GitHub as legit (PR still open or had fixes after revert)">
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                bgcolor: "#3ba272",
                borderRadius: 0.5,
              }}
            />
            <Typography variant="body2">
              <strong>TP</strong> = True Positive (correct autorevert)
            </Typography>
          </Box>
        </Tooltip>
        <Tooltip title="Human reverts with signal recovery - autoreverts should have caught these">
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                bgcolor: "#ed6c02",
                borderRadius: 0.5,
              }}
            />
            <Typography variant="body2">
              <strong>FN</strong> = False Negative (missed by autorevert)
            </Typography>
          </Box>
        </Tooltip>
        <Tooltip title="Autoreverts that were wrong: no signal recovery AND PR was merged unchanged after revert">
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                bgcolor: "#d32f2f",
                borderRadius: 0.5,
              }}
            />
            <Typography variant="body2">
              <strong>FP</strong> = False Positive (incorrect autorevert)
            </Typography>
          </Box>
        </Tooltip>
        <Tooltip title="Signal recoveries from non-revert commits (e.g., flakes, infrastructure issues, fixes)">
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                bgcolor: "#8c8c8c",
                borderRadius: 0.5,
              }}
            />
            <Typography variant="body2">Non-revert recoveries</Typography>
          </Box>
        </Tooltip>
      </Stack>
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
      subtext: "Signal recovery events with precision/recall",
    },
    grid: { top: 80, right: 140, bottom: 60, left: 60 },
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
        "TP (Autorevert)",
        "FN (Human Revert)",
        "FP (Wrong Revert)",
        "Non-Revert Fix",
        "Precision %",
        "Recall %",
      ],
      top: 30,
    },
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        if (!Array.isArray(params)) return "";
        const week = params[0]?.axisValue || "";
        let html = `<strong>${week}</strong><br/>`;
        params.forEach((p: any) => {
          const marker = `<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${p.color};"></span>`;
          const value = typeof p.value === "number" ? p.value : 0;
          const suffix = p.seriesName.includes("%") ? "%" : "";
          html += `${marker}${p.seriesName}: <strong>${value}${suffix}</strong><br/>`;
        });
        return html;
      },
    },
    series: [
      {
        name: "TP (Autorevert)",
        type: "bar",
        stack: "counts",
        data: data.map((d) => d.autorevert_recoveries),
        itemStyle: { color: "#3ba272" },
      },
      {
        name: "FN (Human Revert)",
        type: "bar",
        stack: "counts",
        data: data.map((d) => d.human_revert_recoveries),
        itemStyle: { color: "#ed6c02" },
      },
      {
        name: "FP (Wrong Revert)",
        type: "bar",
        stack: "counts",
        data: data.map((d) => d.false_positives || 0),
        itemStyle: { color: "#d32f2f" },
      },
      {
        name: "Non-Revert Fix",
        type: "bar",
        stack: "counts",
        data: data.map((d) => d.non_revert_recoveries || 0),
        itemStyle: { color: "#8c8c8c" },
      },
      {
        name: "Precision %",
        type: "line",
        yAxisIndex: 1,
        data: data.map((d) => d.precision),
        itemStyle: { color: "#5470c6" },
        lineStyle: { width: 2 },
      },
      {
        name: "Recall %",
        type: "line",
        yAxisIndex: 1,
        data: data.map((d) => d.recall),
        itemStyle: { color: "#91cc75" },
        lineStyle: { width: 2, type: "dashed" },
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

function FalsePositivesTable({ data }: { data: any | undefined }) {
  if (data === undefined) {
    return <Skeleton variant="rectangular" height={300} />;
  }

  const confirmedFPs = data.confirmed || [];
  const legitReverts = data.legit_reverts || [];
  const candidatesChecked = data.candidates_checked || 0;

  if (candidatesChecked === 0) {
    return (
      <Paper sx={{ p: 2 }} elevation={3}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          False Positive Analysis
        </Typography>
        <Typography color="text.secondary">
          No autoreverts without signal recovery found in this time range.
        </Typography>
      </Paper>
    );
  }

  const renderRow = (row: any, idx: number) => (
    <TableRow key={idx}>
      <TableCell sx={{ whiteSpace: "nowrap" }}>
        {dayjs(row.autorevert_time).format("YYYY-MM-DD HH:mm")}
      </TableCell>
      <TableCell>
        <a
          href={`https://github.com/pytorch/pytorch/pull/${row.pr_number}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          #{row.pr_number}
        </a>
      </TableCell>
      <TableCell>
        <Tooltip title={row.verification_reason}>
          <Chip
            label={
              row.verification_status === "confirmed_fp"
                ? "False Positive"
                : "Legit Revert"
            }
            size="small"
            sx={{
              backgroundColor:
                row.verification_status === "confirmed_fp"
                  ? "#d32f2f"
                  : "#3ba272",
              color: "white",
            }}
          />
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip title={row.verification_reason}>
          <span>
            {row.commits_after_revert >= 0 ? row.commits_after_revert : "?"}
          </span>
        </Tooltip>
      </TableCell>
      <TableCell>
        <a
          href={`https://github.com/pytorch/pytorch/commit/${row.reverted_sha}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {row.reverted_sha?.substring(0, 7)}
        </a>
      </TableCell>
      <TableCell>
        <Tooltip title={row.source_signal_keys?.join(", ") || "N/A"}>
          <span>{row.source_signal_keys?.length || 0} signals</span>
        </Tooltip>
      </TableCell>
    </TableRow>
  );

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Typography variant="h6" sx={{ mb: 2 }}>
        False Positive Analysis
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Analyzed {candidatesChecked} autoreverts without signal recovery.{" "}
        <strong style={{ color: "#d32f2f" }}>
          {confirmedFPs.length} confirmed false positive(s)
        </strong>{" "}
        (PR merged with no changes after revert),{" "}
        <strong style={{ color: "#3ba272" }}>
          {legitReverts.length} legit revert(s)
        </strong>{" "}
        (PR still open or had commits after revert).
      </Typography>

      {confirmedFPs.length > 0 && (
        <>
          <Typography
            variant="subtitle2"
            sx={{ mt: 2, mb: 1, color: "#d32f2f" }}
          >
            Confirmed False Positives ({confirmedFPs.length})
          </Typography>
          <TableContainer sx={{ maxHeight: 250, mb: 2 }}>
            <Table stickyHeader size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Autorevert Time</TableCell>
                  <TableCell>PR</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Commits After</TableCell>
                  <TableCell>Reverted SHA</TableCell>
                  <TableCell>Signals</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {confirmedFPs.map((row: any, idx: number) =>
                  renderRow(row, idx)
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      {legitReverts.length > 0 && (
        <>
          <Typography
            variant="subtitle2"
            sx={{ mt: 2, mb: 1, color: "#3ba272" }}
          >
            Legit Reverts ({legitReverts.length}) - No signal recovery but PR
            not relanded unchanged
          </Typography>
          <TableContainer sx={{ maxHeight: 250 }}>
            <Table stickyHeader size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Autorevert Time</TableCell>
                  <TableCell>PR</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Commits After</TableCell>
                  <TableCell>Reverted SHA</TableCell>
                  <TableCell>Signals</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {legitReverts.map((row: any, idx: number) =>
                  renderRow(row, idx)
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
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
        Significant Reverts ({data.length} unique reverts with signal recovery)
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
                      {row.signals_fixed} signal
                      {row.signals_fixed !== 1 ? "s" : ""}
                    </span>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <Chip
                    label={
                      row.recovery_type === "autorevert_recovery" ? "TP" : "FN"
                    }
                    size="small"
                    sx={{
                      backgroundColor:
                        row.recovery_type === "autorevert_recovery"
                          ? "#3ba272"
                          : "#ed6c02",
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
                  {row.reverted_pr_numbers?.length > 0
                    ? row.reverted_pr_numbers.map((pr: string, i: number) => (
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
                    : "-"}
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
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>(
    VIABLE_STRICT_WORKFLOWS
  );

  // Fetch available workflows
  const workflowsUrl = `/api/clickhouse/autorevert_workflows?parameters=${encodeURIComponent(
    JSON.stringify({})
  )}`;
  const { data: availableWorkflows } = useSWR<
    { workflow_name: string; run_count: number }[]
  >(workflowsUrl, fetcher);

  const workflowOptions =
    availableWorkflows?.map((w) => w.workflow_name) || VIABLE_STRICT_WORKFLOWS;

  // Use unified metrics endpoint
  const metricsUrl = `/api/autorevert/metrics?startTime=${encodeURIComponent(
    startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS")
  )}&stopTime=${encodeURIComponent(
    stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS")
  )}&workflowNames=${encodeURIComponent(
    JSON.stringify(selectedWorkflows)
  )}&minRedCommits=${MIN_RED_COMMITS}&minGreenCommits=${MIN_GREEN_COMMITS}`;

  const { data: metricsData } = useSWR(metricsUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
  });

  const summary = metricsData?.summary;

  return (
    <Stack spacing={3} sx={{ p: 3 }}>
      <Box
        sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}
      >
        <Typography variant="h4" fontWeight="bold">
          Autorevert Metrics
        </Typography>
        <Chip label="BETA" color="warning" size="small" />
      </Box>

      <Typography variant="body2" color="text.secondary">
        Tracks autorevert system performance using precision/recall metrics.
        <strong> Precision</strong> = TP / (TP + FP) measures how often
        autoreverts are correct.
        <strong> Recall</strong> = TP / (TP + FN) measures how many reverts
        autorevert catches. Signal recovery = job group transitions from 2+ red
        commits to 2+ green commits.
      </Typography>

      <Box
        sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}
      >
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Box>

      <Box
        sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}
      >
        <Autocomplete
          multiple
          size="small"
          options={workflowOptions}
          value={selectedWorkflows}
          onChange={(_, newValue) => setSelectedWorkflows(newValue)}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Workflows"
              placeholder="Select workflows"
            />
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
        <Grid size={{ xs: 6, sm: 2 }}>
          <ScalarMetric
            title="Precision"
            value={
              summary?.precision !== undefined
                ? `${summary.precision}%`
                : undefined
            }
            tooltip="TP / (TP + FP) - How often autoreverts are correct"
            color="#5470c6"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 2 }}>
          <ScalarMetric
            title="Recall"
            value={
              summary?.recall !== undefined ? `${summary.recall}%` : undefined
            }
            tooltip="TP / (TP + FN) - How many reverts autorevert catches"
            color="#91cc75"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 2 }}>
          <ScalarMetric
            title="True Positives"
            value={summary?.true_positives}
            tooltip={`Correct autoreverts: ${
              summary?.tp_with_signal_recovery || 0
            } with signal recovery + ${
              summary?.tp_without_signal_recovery || 0
            } verified legit (PR not relanded unchanged)`}
            color="#3ba272"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 2 }}>
          <ScalarMetric
            title="False Positives"
            value={summary?.confirmed_false_positives}
            tooltip="Autoreverts without signal recovery, verified via GitHub API"
            color="#d32f2f"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 2 }}>
          <ScalarMetric
            title="False Negatives"
            value={summary?.false_negatives}
            tooltip="Human reverts with signal recovery (missed by autorevert)"
            color="#ed6c02"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 2 }}>
          <ScalarMetric
            title="Total Autoreverts"
            value={summary?.total_autoreverts}
            tooltip="Total autorevert events in the selected workflows"
          />
        </Grid>
      </Grid>

      {/* Metrics Legend */}
      <MetricsLegend />

      {/* Weekly Trend Chart */}
      <WeeklyTrendChart data={metricsData?.weeklyMetrics} />

      {/* Significant Reverts Table */}
      <SignificantRevertsTable data={metricsData?.significantReverts} />

      {/* False Positives Table */}
      <FalsePositivesTable data={metricsData?.falsePositives} />
    </Stack>
  );
}
