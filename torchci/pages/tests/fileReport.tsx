import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import WarningRoundedIcon from "@mui/icons-material/WarningRounded";
import {
  Box,
  Button,
  ButtonGroup,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  DataGrid,
  GridColDef,
  GridRenderCellParams,
  GridTreeNodeWithRender,
} from "@mui/x-data-grid";
import CopyLink from "components/common/CopyLink";
import LoadingPage from "components/common/LoadingPage";
import RegexButton from "components/common/RegexButton";
import { durationDisplay } from "components/common/TimeUtils";
import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import ReactECharts from "echarts-for-react";
import { encodeParams } from "lib/GeneralUtils";
import _ from "lodash";
import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import useSWRImmutable from "swr/immutable";

dayjs.extend(isoWeek);

const S3_LOCATION =
  "https://ossci-raw-job-status.s3.amazonaws.com/additional_info/weekly_file_report";

function formatTimestamp(ts: number) {
  return new Date(ts * 1000).toLocaleDateString().slice(0, 10);
}

function roundedCostCell(params: GridRenderCellParams) {
  if (params.value != null) {
    return <>{params.value.toFixed(2)} </>;
  }
  return <></>;
}

function renderTimeCell(
  params: GridRenderCellParams<any, any, any, GridTreeNodeWithRender>
) {
  if (isNaN(params.value)) {
    return "";
  }
  const value = parseFloat(params.value);

  return durationDisplay(value);
}

function renderHeader(title: string, tooltip: string) {
  return (
    <Tooltip title={tooltip}>
      <Typography fontWeight={"bold"} variant="body2">
        {title}
      </Typography>
    </Tooltip>
  );
}

// Helper to match with optional regex
function matchField(value: string, filter: string, useRegex: boolean) {
  if (!filter) return true;
  if (!value) return false;
  if (useRegex) {
    try {
      return new RegExp(filter).test(value);
    } catch {
      return false;
    }
  }
  return value === filter;
}

// Helper for label (array or string)
function matchLabel(
  labels: string[] | string,
  filter: string,
  useRegex: boolean
) {
  if (!filter) return true;
  if (!labels) return false;
  if (Array.isArray(labels)) {
    return labels.some((l) => matchField(l, filter, useRegex));
  }
  return matchField(labels, filter, useRegex);
}

function Diffs({
  data,
  setFileFilter,
  setJobFilter,
}: {
  data: { [key: string]: any }[];
  setFileFilter: (v: string) => void;
  setJobFilter: (v: string) => void;
}) {
  // Get all unique commits sorted by push_date
  const allCommits = _.uniqBy(data, "sha")
    .map((d) => ({ sha: d.sha, push_date: d.push_date }))
    .sort((a, b) => a.push_date - b.push_date);

  // State for selected commits (default to first and last)
  const [firstCommitIndex, setFirstCommitIndex] = useState(0);
  const [lastCommitIndex, setLastCommitIndex] = useState(allCommits.length - 1);

  // Update indices when data changes
  useEffect(() => {
    setFirstCommitIndex(0);
    setLastCommitIndex(allCommits.length - 1);
  }, [allCommits.length]);

  const firstCommit = allCommits[firstCommitIndex] || allCommits[0];
  const lastCommit =
    allCommits[lastCommitIndex] || allCommits[allCommits.length - 1];

  // Group data by (file, short_job_name)
  const groupedData = _.groupBy(data, (d) => `${d.file}|||${d.short_job_name}`);

  // Create one row per (file, job) with diffs.  If the data is missing for the
  // specific shas, use interpolation based on nearest available data points.
  const diffRows = Object.entries(groupedData).map(([key, arr], index) => {
    const [file, jobName] = key.split("|||");

    // Helper to get interpolated value for a commit
    const getInterpolatedValue = (targetCommit: any, field: string) => {
      // Find exact match first
      const exactMatch = arr.find((row) => row.sha === targetCommit.sha);
      if (exactMatch) {
        return exactMatch[field] || 0;
      }

      // Sort by push_date for interpolation
      const sorted = _.sortBy(arr, "push_date");

      // Find the closest existing values before and after
      const before = sorted
        .filter((row) => row.push_date <= targetCommit.push_date)
        .sort((a, b) => b.push_date - a.push_date)[0];
      const after = sorted
        .filter((row) => row.push_date > targetCommit.push_date)
        .sort((a, b) => a.push_date - b.push_date)[0];

      // If we have data on the target commit or later, use the first available
      if (after) return after[field] || 0;
      // Otherwise use the last available before
      if (before) return before[field] || 0;
      // Default to 0 if no data exists
      return 0;
    };

    // Get interpolated values for first and last commits
    const firstValues = {
      time: getInterpolatedValue(firstCommit, "time"),
      cost: getInterpolatedValue(firstCommit, "cost"),
      count: getInterpolatedValue(firstCommit, "count"),
      skipped: getInterpolatedValue(firstCommit, "skipped"),
    };

    const lastValues = {
      time: getInterpolatedValue(lastCommit, "time"),
      cost: getInterpolatedValue(lastCommit, "cost"),
      count: getInterpolatedValue(lastCommit, "count"),
      skipped: getInterpolatedValue(lastCommit, "skipped"),
      frequency: getInterpolatedValue(lastCommit, "frequency"),
    };

    return {
      id: index,
      file,
      short_job_name: jobName,
      // Last commit values
      time: lastValues.time,
      cost: lastValues.cost,
      skipped: lastValues.skipped,
      count: lastValues.count,
      frequency: lastValues.frequency,
      // Deltas (last - first)
      time_diff: lastValues.time - firstValues.time,
      cost_diff: lastValues.cost - firstValues.cost,
      skipped_diff: lastValues.skipped - firstValues.skipped,
      count_diff: lastValues.count - firstValues.count,
    };
  });

  const columns: GridColDef[] = [
    {
      field: "file",
      headerName: "File",
      flex: 4,
      renderCell: (params: any) => (
        <span
          style={{ cursor: "pointer" }}
          onDoubleClick={() => setFileFilter(params.value)}
          title="Double-click to filter by this file"
        >
          {params.value}
        </span>
      ),
      renderHeader: () =>
        renderHeader("File", "Double click to filter by this file"),
    },
    {
      field: "short_job_name",
      headerName: "Job",
      flex: 4,
      renderHeader: () =>
        renderHeader("Job", "Double click to filter by this job"),
      renderCell: (params: any) => (
        <span
          style={{ cursor: "pointer" }}
          onDoubleClick={() => setJobFilter(params.value)}
        >
          {params.value}
        </span>
      ),
    },
    {
      field: "count",
      headerName: "Count",
      flex: 1,
      renderHeader: () => renderHeader("Count", "Number of tests"),
    },
    {
      field: "count_diff",
      headerName: "Δ Count",
      flex: 1,
      cellClassName: (params: any) => {
        const value = parseFloat(params.value);
        const base = parseFloat(params.row?.count);
        if (!isNaN(value) && base && Math.abs(value) / base > 0.2) {
          return "highlight";
        }
        if (Math.abs(value) > 20) {
          return "highlight";
        }
        return "change";
      },
    },
    {
      field: "time",
      headerName: "Duration",
      flex: 1,
      renderCell: renderTimeCell,
      renderHeader: () => renderHeader("Duration", "Duration of the test(s)"),
    },
    {
      field: "time_diff",
      headerName: "Δ Duration",
      flex: 1,
      cellClassName: (params: any) => {
        const value = parseFloat(params.value);
        const base = parseFloat(params.row?.time);
        if (!isNaN(value) && base && Math.abs(value) / base > 0.2) {
          return "highlight";
        }
        if (Math.abs(value) > 30 * 60) {
          return "highlight";
        }
        return "change";
      },
      renderCell: renderTimeCell,
    },
    {
      field: "cost",
      headerName: "Cost ($)",
      flex: 1,
      renderCell: roundedCostCell,
      renderHeader: () =>
        renderHeader(
          "Cost ($)",
          "Estimated cost of the test(s) for one commit"
        ),
    },
    {
      field: "cost_diff",
      headerName: "Δ Cost",
      flex: 1,
      cellClassName: (params: any) => {
        const value = parseFloat(params.value);
        const base = parseFloat(params.row?.cost);
        if (!isNaN(value) && base && Math.abs(value) / base > 0.2) {
          return "highlight";
        }
        if (Math.abs(value) > 500) {
          return "highlight";
        }
        return "change";
      },
      renderCell: roundedCostCell,
    },
    // { field: "errors", headerName: "Errors", flex: 1 },
    // {
    //   field: "errors_diff",
    //   headerName: "Δ Errors",
    //   flex: 1,
    //   getCellClassName: () => "change",
    // },
    // { field: "failures", headerName: "Failures", flex: 1 },
    // {
    //   field: "failures_diff",
    //   headerName: "Δ Failures",
    //   flex: 1,
    //   getCellClassName: () => "change",
    // },
    { field: "skipped", headerName: "Skipped", flex: 1 },
    {
      field: "skipped_diff",
      headerName: "Δ Skipped",
      flex: 1,
      cellClassName: (params: any) => {
        const value = parseFloat(params.value);
        const base = parseFloat(params.row?.skipped);
        if (!isNaN(value) && base && Math.abs(value) / base > 0.2) {
          return "highlight";
        }
        if (Math.abs(value) > 20) {
          return "highlight";
        }
        return "change";
      },
    },
    {
      field: "frequency",
      headerName: "Frequency",
      flex: 1,
      renderHeader: () =>
        renderHeader(
          "Frequency",
          "Estimated frequency of test runs for this file (# commits it is run on) in the last week"
        ),
    },
    // { field: "successes", headerName: "Successes", flex: 1 },
    // {
    //   field: "successes_diff",
    //   headerName: "Δ Successes",
    //   flex: 1,
    //   getCellClassName: () => "change",
    // },
  ];

  const styling = {
    "& .total-row": {
      fontWeight: "bold",
      backgroundColor: "rgba(213, 213, 213, 0.25)",
    },
    "& .change": {
      backgroundColor: "rgba(213, 213, 213, 0.25)",
    },
    "& .highlight": {
      backgroundColor: "var(--warning-button-bg)",
    },
  };
  return (
    <Stack spacing={2}>
      <Typography variant="h6">File Test Counts</Typography>
      <Typography variant="body1">
        This table displays test run statistics for each test file and job
        combination, comparing two selected commits. The Δ (delta) columns show
        the change in each metric. Values are interpolated if a file/job
        combination does not exist on the exact commits (using the nearest
        available data point). Double click on the file or job to filter by that
        value. Highlighted cells are large changes (either by percent or
        absolute value) and may indicate regressions or improvements.
      </Typography>
      <Typography variant="body1">
        Pricing is approximate and per commit. Some pricing data may be missing
        (ex mac, rocm), in those cases the cost will be 0.
      </Typography>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="body2">Compare:</Typography>
        <Select
          size="small"
          value={firstCommitIndex}
          onChange={(e) => setFirstCommitIndex(Number(e.target.value))}
          sx={{ minWidth: 200 }}
        >
          {allCommits.map((commit, index) => (
            <MenuItem key={index} value={index}>
              {commit.sha.slice(0, 7)} ({formatTimestamp(commit.push_date)})
            </MenuItem>
          ))}
        </Select>
        <Typography variant="body2">vs</Typography>
        <Select
          size="small"
          value={lastCommitIndex}
          onChange={(e) => setLastCommitIndex(Number(e.target.value))}
          sx={{ minWidth: 200 }}
        >
          {allCommits.map((commit, index) => (
            <MenuItem key={index} value={index}>
              {commit.sha.slice(0, 7)} ({formatTimestamp(commit.push_date)})
            </MenuItem>
          ))}
        </Select>
      </Stack>

      <Box height={"600px"}>
        <DataGrid
          density="compact"
          rows={diffRows}
          sx={styling}
          columns={columns}
          initialState={{
            sorting: {
              sortModel: [{ field: "cost_diff", sort: "desc" }],
            },
          }}
        />
      </Box>
    </Stack>
  );
}

function CommitTimeline({ data }: { data: any[] }) {
  const sortedData = [...data].sort(
    (a, b) => new Date(a.push_date).getTime() - new Date(b.push_date).getTime()
  );

  const option = {
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const p = params[0].data;
        return `SHA: ${p.sha}<br/>Date: ${new Date(
          p.date * 1000
        ).toLocaleString()}`;
      },
    },
    xAxis: {
      type: "time",
      name: "Push Date",
    },
    yAxis: {
      type: "value",
      show: false, // optional, since commits are all on the same level
    },
    series: [
      {
        type: "line",
        data: sortedData.map((commit) => ({
          value: [new Date(commit.push_date * 1000), 1],
          sha: commit.sha,
          date: commit.push_date,
        })),
        symbolSize: 10,
        lineStyle: {
          color: "#1976d2",
        },
        itemStyle: {
          color: "#1976d2",
        },
        showSymbol: true, // show dots at commits
      },
    ],
    grid: {
      left: "10%",
      right: "10%",
      bottom: "20%",
      top: "20%",
    },
  };

  return (
    <>
      <Typography variant="body1" sx={{ mb: 2 }}>
        <strong>Commit Timeline:</strong> The timeline below visualizes the
        sequence of commits included in this report. Each point represents a
        commit, arranged chronologically from left to right. Hover over a point
        to see the commit SHA and its push date.
      </Typography>
      <ReactECharts option={option} style={{ height: 200, width: "100%" }} />
    </>
  );
}

function Overview({
  data,
  setFileFilter,
  setJobFilter,
  setLabelFilter,
}: {
  data: { [key: string]: any }[];
  setFileFilter: (_: string) => void;
  setJobFilter: (_: string) => void;
  setLabelFilter: (_: string) => void;
}) {
  const groupByOptions = {
    file: {
      headerName: "File",
      field: "file",
      buttonText: "Group by File",
      onDoubleClick: (value: any) => setFileFilter(value),
      onDoubleClickHelpText: "Double-click to filter by this file",
      groupByKey: (v: any) => [v.file],
    },
    job: {
      headerName: "Job",
      field: "short_job_name",
      buttonText: "Group by Job",
      onDoubleClick: (value: any) => setJobFilter(value),
      onDoubleClickHelpText: "Double-click to filter by this job",
      groupByKey: (v: any) => [v.short_job_name],
    },
    label: {
      headerName: "Label",
      field: "labels",
      buttonText: "Group by Label",
      onDoubleClick: (value: any) => setLabelFilter(value),
      onDoubleClickHelpText: "Double-click to filter by this label",
      groupByKey: (v: any) => v.labels,
    },
    total: {
      headerName: "Total",
      field: "total",
      buttonText: "Total",
      onDoubleClick: () => {},
      onDoubleClickHelpText: "",
      groupByKey: (_: any) => ["total"],
    },
  };
  const [groupBy, setGroupBy] = useState<keyof typeof groupByOptions>("file");
  const columns: any[] = [
    {
      field: groupByOptions[groupBy].field,
      headerName: groupByOptions[groupBy].headerName,
      flex: 4,
      renderCell: (params: any) => (
        <span
          style={{ cursor: "pointer" }}
          onDoubleClick={() =>
            groupByOptions[groupBy].onDoubleClick(params.value)
          }
          title={groupByOptions[groupBy].onDoubleClickHelpText}
        >
          {params.value}
        </span>
      ),
      renderHeader: () =>
        renderHeader(
          groupByOptions[groupBy].headerName,
          groupByOptions[groupBy].onDoubleClickHelpText
        ),
    },
    {
      field: "count",
      headerName: "Count",
      flex: 1,
      renderHeader: () => renderHeader("Count", "Number of tests"),
    },
    {
      field: "time",
      headerName: "Duration",
      flex: 1,
      renderCell: renderTimeCell,
      renderHeader: () =>
        renderHeader(
          "Duration",
          "Duration of the test(s) for one commit if run sequentially"
        ),
    },
    {
      field: "cost",
      headerName: "Cost ($)",
      flex: 1,
      renderCell: roundedCostCell,
      renderHeader: () =>
        renderHeader(
          "Cost ($)",
          "Estimated cost of the test(s) for one commit"
        ),
    },
    {
      field: "skipped",
      headerName: "Skipped",
      flex: 1,
      renderHeader: () => renderHeader("Skipped", "Number of skipped tests"),
    },
    // {
    //   field: "frequency",
    //   headerName: "Frequency",
    //   flex: 1,
    //   renderHeader: () =>
    //     renderHeader("Frequency", "Frequency of test runs for this file"),
    // },
  ];

  const groupByTarget = _.reduce(
    data,
    (acc, row) => {
      const keys = groupByOptions[groupBy].groupByKey(row) as string[];
      keys.forEach((key) => {
        acc[key] = acc[key] || [];
        acc[key].push(row);
      });
      return acc;
    },
    {} as Record<string, any[]>
  );

  const groupedRows = _.map(groupByTarget, (rows, key) => {
    // Sum
    const summed = _.reduce(
      rows,
      (acc, row) => {
        acc.count += row.count || 0;
        acc.time += row.time || 0;
        acc.cost += row.cost || 0;
        acc.skipped += row.skipped || 0;
        acc.frequency += row.frequency || 0;
        return acc;
      },
      { count: 0, time: 0, cost: 0, skipped: 0, frequency: 0 }
    );

    // Average across sha data points
    const numShas = _.uniq(rows.map((r) => r.sha)).length;
    return {
      id: rows[0].id,
      file: rows[0].file,
      short_job_name: rows[0].short_job_name,
      labels: key,
      count: summed.count / numShas,
      time: summed.time / numShas,
      cost: summed.cost / numShas,
      skipped: summed.skipped / numShas,
      frequency: summed.frequency / numShas,
    };
  });

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Overview</Typography>
      <Typography variant="body1">
        This section provides an overview of the test statistics. Values are
        summed within a commit, then averaged.
      </Typography>
      <Typography variant="body1">
        Pricing is approximate and per commit. Some pricing data may be missing
        (ex mac, rocm), in those cases the cost will be 0.
      </Typography>
      <Box mb={2}>
        <ButtonGroup variant="outlined" size="small">
          {Object.entries(groupByOptions).map(([key, setting]) => (
            <Button
              key={setting.field}
              variant={groupBy === key ? "contained" : "outlined"}
              onClick={() => setGroupBy(key as keyof typeof groupByOptions)}
            >
              {setting.buttonText}
            </Button>
          ))}
        </ButtonGroup>
      </Box>
      <Box height={"600px"}>
        <DataGrid
          density="compact"
          rows={groupedRows}
          columns={columns}
          initialState={{
            sorting: {
              sortModel: [{ field: "cost", sort: "desc" }],
            },
          }}
        />
      </Box>
    </Stack>
  );
}

function Graphs({ data }: { data: any[] }) {
  // Map selector value to field and label
  const groupByOptions = {
    file: {
      getGroupByField: (d: any) => d.file,
      groupByButtonText: "Group by File",
    },
    job: {
      getGroupByField: (d: any) => d.short_job_name,
      groupByButtonText: "Group by Job",
    },
    filejob: {
      getGroupByField: (d: any) => `${d.short_job_name} | ${d.file}`,
      groupByButtonText: "Group by File + Job",
    },
    total: {
      getGroupByField: (_: any) => `total`,
      groupByButtonText: "Total",
    },
  };
  const metricOptions = {
    count: { label: "Count", field: "count" },
    cost: { label: "Cost", field: "cost" },
    duration: { label: "Duration", field: "time" },
    skips: { label: "Skips", field: "skipped" },
  };

  const [metric, setMetric] = useState<keyof typeof metricOptions>("count");
  const [groupBy, setGroupBy] = useState<keyof typeof groupByOptions>("file");

  const chartData = _.map(
    // Group by the sha and the option that is selected
    _.groupBy(data, (d) => {
      return [d.sha, groupByOptions[groupBy].getGroupByField(d)];
    }),
    // Sum over each group
    (rows, key) => {
      return {
        push_date: rows[0].push_date,
        key: key.split(",")[1],
        [metricOptions[metric].field]: _.sumBy(
          rows,
          (d) => d[metricOptions[metric].field]
        ),
      };
    }
  );
  // Convert to series
  const echartData = _.map(_.groupBy(chartData, "key"), (rows) => ({
    name: rows[0].key,
    type: "line",
    data: rows.map((r) => [r.push_date, r[metricOptions[metric].field]]),
  }));
  const option = {
    tooltip: { trigger: "axis" },
    legend: {
      type: "scroll",
      orient: "vertical",
      right: 10,
      selector: [
        {
          type: "all",
          title: "All",
        },
        {
          type: "inverse",
          title: "Inv",
        },
      ],
    },
    xAxis: { type: "time", name: "Push Date" },
    yAxis: { type: "value", name: metricOptions[metric].label },
    series: echartData,
  };

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Graphs</Typography>
      <Typography variant="body1" sx={{ mb: 1 }}>
        The charts below visualize trends in the selected metric (Count, Cost,
        Duration, or Skips) over time, grouped by file name, job name, or both.
        Use these charts to spot regressions, improvements, or anomalies in test
        performance across recent commits.
      </Typography>
      <ButtonGroup variant="outlined" size="small" sx={{ mb: 2 }}>
        {Object.entries(metricOptions).map(([key, option]) => (
          <Button
            key={key}
            variant={metric === key ? "contained" : "outlined"}
            onClick={() => setMetric(key as keyof typeof metricOptions)}
          >
            {option.label}
          </Button>
        ))}
      </ButtonGroup>
      <ButtonGroup variant="outlined" size="small" sx={{ mb: 2 }}>
        {Object.entries(groupByOptions).map(([key, option]) => (
          <Button
            key={key}
            variant={groupBy === key ? "contained" : "outlined"}
            onClick={() => setGroupBy(key as keyof typeof groupByOptions)}
          >
            {option.groupByButtonText}
          </Button>
        ))}
      </ButtonGroup>
      <Box height="600px">
        <ReactECharts
          // key is needed to force re-rendering when data changes
          key={JSON.stringify(chartData)}
          option={option}
          style={{ height: 600 }}
        />
      </Box>
    </Stack>
  );
}

function StatusIcon({ status }: { status: string }) {
  let icon = null;
  if (status === "failure") {
    icon = <ErrorIcon sx={{ color: "red", fontSize: "1rem" }} />;
  } else if (status === "flaky") {
    icon = <WarningRoundedIcon sx={{ color: "orange", fontSize: "1rem" }} />;
  } else if (status === "success") {
    icon = <CheckCircleIcon sx={{ color: "green", fontSize: "1rem" }} />;
  } else if (status === "skipped") {
    icon = <WarningRoundedIcon sx={{ color: "grey", fontSize: "1rem" }} />;
  } else if (status === "removed") {
    icon = <RemoveCircleOutlineIcon sx={{ color: "red", fontSize: "1rem" }} />;
  } else if (status === "added") {
    icon = <AddCircleOutlineIcon sx={{ color: "green", fontSize: "1rem" }} />;
  }
  return icon;
}

function useStatusChangeData(
  uniqueFiles: string[],
  uniqueJobs: string[],
  sha1: string,
  sha2: string
) {
  // Sort for consistent cache keys and remove .py suffixes
  const sortedFiles = [...uniqueFiles]
    .sort()
    .map((f) => f.slice(0, f.length - 3));
  const sortedJobs = [...uniqueJobs].sort();

  const swrKey =
    sha1 && sha2
      ? `/api/flaky-tests/statusChanges:${sha1}:${sha2}:${JSON.stringify(
          sortedFiles
        )}:${JSON.stringify(sortedJobs)}`
      : null;

  // Custom fetcher for POST requests to get around URL header length limits
  const postFetcher = async () => {
    const response = await fetch("/api/flaky-tests/statusChanges", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sha1,
        sha2,
        files: sortedFiles,
        jobs: sortedJobs,
        fuzzy: true, // Enable fuzzy matching to find nearest jobs
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
  };

  const { data, error, isLoading } = useSWRImmutable(swrKey, postFetcher);

  return {
    data: data || [],
    error,
    isLoading,
  };
}

function TestStatus({
  shas,
  data,
}: {
  shas: { sha: string; push_date: number }[];
  data: any[];
}) {
  // Sort commits by date ascending (oldest first)
  const allCommits = [...shas].sort((a, b) => a.push_date - b.push_date);

  // State for selected commits (default to first and last)
  const [firstCommitIndex, setFirstCommitIndex] = useState(0);
  const [lastCommitIndex, setLastCommitIndex] = useState(allCommits.length - 1);

  // Update indices when data changes
  useEffect(() => {
    setFirstCommitIndex(0);
    setLastCommitIndex(allCommits.length - 1);
  }, [allCommits.length]);

  // Extract unique files and jobs from the filtered data
  const uniqueFiles = _.uniq(data.map((d) => d.file));
  const uniqueJobs = _.uniq(data.map((d) => d.short_job_name));

  // Fetch status changes from API
  const sha1 = allCommits[firstCommitIndex]?.sha;
  const sha2 = allCommits[lastCommitIndex]?.sha;

  const statusChangeResult = useStatusChangeData(
    uniqueFiles,
    uniqueJobs,
    sha1,
    sha2
  );

  // Transform the data
  const statusData = (statusChangeResult.data || []).map(
    (row: any, index: number) => ({
      id: index,
      prev_status: row.prev_status,
      new_status: row.new_status,
      file: row.invoking_file,
      test_name: row.name,
      short_job_name: `${row.workflow_name} / ${row.job_name}`,
      classname: row.classname,
    })
  );

  const columns: any[] = [
    {
      field: "status",
      headerName: "Status",
      flex: 2,
      valueGetter: (_value: any, row: any) => {
        // Create a sortable string from prev_status and new_status
        const prev = row.prev_status || "none";
        const next = row.new_status || "none";
        return `${prev} → ${next}`;
      },
      renderCell: (params: any) => {
        const prevStatus = params.row.prev_status || "";
        const newStatus = params.row.new_status || "";

        const prevText = prevStatus === "" ? "none" : prevStatus;
        const newText = newStatus === "" ? "none" : newStatus;

        return (
          <Stack direction="row" spacing={0.5} alignItems="center">
            {prevStatus && <StatusIcon status={prevStatus} />}
            <span
              key="prev-status"
              style={{
                fontStyle: prevStatus === "" ? "italic" : "normal",
                color: prevStatus === "" ? "gray" : "inherit",
              }}
            >
              {prevText}
            </span>
            <span key="arrow">→</span>
            {newStatus && <StatusIcon status={newStatus} />}
            <span
              key="new-status"
              style={{
                fontStyle: newStatus === "" ? "italic" : "normal",
                color: newStatus === "" ? "gray" : "inherit",
              }}
            >
              {newText}
            </span>
          </Stack>
        );
      },
    },
    { field: "file", headerName: "File", flex: 2 },
    { field: "test_name", headerName: "Test", flex: 4 },
    { field: "short_job_name", headerName: "Job", flex: 4 },
  ];

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="body2">Compare:</Typography>
        <Select
          size="small"
          value={firstCommitIndex}
          onChange={(e) => setFirstCommitIndex(Number(e.target.value))}
          sx={{ minWidth: 200 }}
        >
          {allCommits.map((commit, index) => (
            <MenuItem key={index} value={index}>
              {commit.sha.slice(0, 7)} ({formatTimestamp(commit.push_date)})
            </MenuItem>
          ))}
        </Select>
        <Typography variant="body2">vs</Typography>
        <Select
          size="small"
          value={lastCommitIndex}
          onChange={(e) => setLastCommitIndex(Number(e.target.value))}
          sx={{ minWidth: 200 }}
        >
          {allCommits.map((commit, index) => (
            <MenuItem key={index} value={index}>
              {commit.sha.slice(0, 7)} ({formatTimestamp(commit.push_date)})
            </MenuItem>
          ))}
        </Select>
      </Stack>

      {statusChangeResult.isLoading && (
        <Typography variant="body2" color="text.secondary">
          Loading status changes...
        </Typography>
      )}

      {statusChangeResult.error && (
        <Typography variant="body2" color="error">
          Error loading status changes: {statusChangeResult.error.message}
        </Typography>
      )}

      <Box height={"600px"}>
        <DataGrid
          density="compact"
          rows={statusData}
          columns={columns}
          loading={statusChangeResult.isLoading}
        />
      </Box>
    </Stack>
  );
}

// Custom hook to fetch real data from the local JSON file
function useData(link: string | undefined) {
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    if (!link) return;

    fetch(link)
      .then((response) =>
        response.ok ? response.text() : Promise.reject("Failed to load")
      )
      .then((text) => {
        const final = [];
        for (const line of text.split("\n")) {
          if (line.trim()) {
            final.push(JSON.parse(line));
          }
        }
        setData(final.map((item, index) => ({ ...item, id: index })));
      });
  }, [link]);
  return data;
}

function useWeeksData(commitMetadata: any[], headShaIndex: number) {
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    if (headShaIndex == -1 || commitMetadata.length === 0) return;

    const shasToFetch = [];
    for (let i = headShaIndex; i >= 0 && i > headShaIndex - 7; --i) {
      shasToFetch.push(commitMetadata[i].sha);
    }

    Promise.all(
      shasToFetch.map((sha) =>
        fetch(`${S3_LOCATION}/data_${sha}.json.gz`)
          .then((response) =>
            response.ok ? response.text() : Promise.reject("Failed to load")
          )
          .then((text) => {
            const final = [];
            for (const line of text.split("\n")) {
              if (line.trim()) {
                final.push(JSON.parse(line));
              }
            }
            return final.map((item, index) => ({ ...item, id: index }));
          })
      )
    ).then((allData) => {
      // Flatten the array of arrays
      setData(allData.flat());
    });
  }, [commitMetadata, headShaIndex]);
  return data;
}

export default function Page() {
  const [useOrFilter, setUseOrFilter] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [jobFilter, setJobFilter] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [fileRegex, setFileRegex] = useState(false);
  const [jobRegex, setJobRegex] = useState(false);
  const [labelRegex, setLabelRegex] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jobInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const [baseUrl, setBaseUrl] = useState<string>("");

  // Keep input fields in sync when filters are set programmatically
  useEffect(() => {
    if (fileInputRef.current && fileInputRef.current.value !== fileFilter) {
      fileInputRef.current.value = fileFilter;
    }
  }, [fileFilter]);
  useEffect(() => {
    if (jobInputRef.current && jobInputRef.current.value !== jobFilter) {
      jobInputRef.current.value = jobFilter;
    }
  }, [jobFilter]);
  useEffect(() => {
    if (labelInputRef.current && labelInputRef.current.value !== labelFilter) {
      labelInputRef.current.value = labelFilter;
    }
  }, [labelFilter]);

  const router = useRouter();
  const commitMetadata = useData(`${S3_LOCATION}/commits_metadata.json.gz`);
  const [headShaIndex, setHeadShaIndex] = useState<number>(
    commitMetadata.length - 1
  );

  let data = useWeeksData(commitMetadata, headShaIndex).map((item, index) => ({
    ...item,
    id: index,
  }));

  useEffect(() => {
    if (headShaIndex == -1 && commitMetadata.length > 0) {
      setHeadShaIndex(commitMetadata.length - 1);
    }
  }, [commitMetadata, headShaIndex]);

  useEffect(() => {
    // Sync filters from the router query params in one effect to avoid
    // repeating similar hooks. Only update when the specific query keys
    // are present.
    const q = router.query;
    if (q.label) setLabelFilter(q.label as string);
    if (q.job) setJobFilter(q.job as string);
    if (q.file) setFileFilter(q.file as string);

    if (q.labelRegex !== undefined) setLabelRegex(q.labelRegex === "true");
    if (q.fileRegex !== undefined) setFileRegex(q.fileRegex === "true");
    if (q.jobRegex !== undefined) setJobRegex(q.jobRegex === "true");

    if (q.useOrFilter !== undefined) setUseOrFilter(q.useOrFilter === "true");

    setBaseUrl(
      `${window.location.protocol}//${
        window.location.host
      }${router.asPath.replace(/\?.+/, "")}`
    );
  }, [router.query]);

  if (!router.isReady) {
    return <LoadingPage />;
  }

  // Filter data by file, job, and label with regex support
  function rowMatchesFilters(row: any) {
    const fileMatch = matchField(row.file, fileFilter, fileRegex);
    const jobMatch = matchField(row.short_job_name, jobFilter, jobRegex);
    const labelMatch = matchLabel(row.labels, labelFilter, labelRegex);
    if (useOrFilter) {
      return (
        (!fileFilter && !jobFilter && !labelFilter) ||
        (fileFilter !== "" && fileMatch) ||
        (jobFilter !== "" && jobMatch) ||
        (labelFilter !== "" && labelMatch)
      );
    }
    return fileMatch && jobMatch && labelMatch;
  }

  const shas = _(data)
    .map((row) => ({
      sha: row.sha,
      push_date: row.push_date,
    }))
    .uniqBy("sha")
    .value();

  const filteredData = data.filter(rowMatchesFilters);
  data = filteredData;

  return (
    <Stack spacing={4}>
      <Stack direction="row" spacing={2}>
        <Typography variant="h4">Test Reports</Typography>
        {/* Permalink */}
        <CopyLink
          textToCopy={`${baseUrl}?${encodeParams({
            file: fileFilter,
            job: jobFilter,
            label: labelFilter,
            fileRegex: fileRegex ? "true" : "false",
            jobRegex: jobRegex ? "true" : "false",
            labelRegex: labelRegex ? "true" : "false",
            useOrFilter: useOrFilter ? "true" : "false",
          })}`}
        />
      </Stack>

      <Stack spacing={2}>
        <Typography variant="body1">
          This provides insights into the test files executed over recent
          commits. It includes statistics on test counts, durations, costs, and
          skips, along with visualizations to help identify trends and
          anomalies. Use the filters below to narrow down the data by specific
          files, jobs, or labels.
        </Typography>
        <Typography variant="body1">
          This should include most python unittests that are commonly run on
          PRs. A non exhaustive list of what is not included is benchmarking,
          periodic tests, inductor graph break model regression runs, and
          overhead for running tests.
        </Typography>
        <Typography variant="body1">
          `module: unknown` is the catch all for tests which do not have a clear
          owner label. If a label is incorrect, you can change this in test file
          in `pytorch/pytorch`.
        </Typography>
        <Typography variant="body1">
          Select a commit to view data from the week leading up to that commit.
        </Typography>
      </Stack>
      <Select
        name="commit"
        value={headShaIndex}
        onChange={(e) => {
          const selectedIndex = e.target.value;
          setHeadShaIndex(selectedIndex);
        }}
      >
        {commitMetadata.map((commit, index) => (
          <MenuItem value={index} key={index}>
            {commit.sha.slice(0, 7)} ({formatTimestamp(commit.push_date)})
          </MenuItem>
        ))}
      </Select>
      <Box
        component="form"
        noValidate
        autoComplete="off"
        sx={{
          display: "flex",
          alignItems: "center",
          "& .MuiTextField-root": {
            marginRight: 1,
            width: "25ch",
          },
          "& .MuiButton-root": {
            marginLeft: 2,
          },
        }}
        onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (fileInputRef.current) setFileFilter(fileInputRef.current.value);
          if (jobInputRef.current) setJobFilter(jobInputRef.current.value);
          if (labelInputRef.current)
            setLabelFilter(labelInputRef.current.value);
        }}
      >
        {[
          {
            label: "Filter by Label",
            inputRef: labelInputRef,
            value: labelFilter,
            setRegex: setLabelRegex,
            regex: labelRegex,
          },
          {
            label: "Filter by File",
            inputRef: fileInputRef,
            value: fileFilter,
            setRegex: setFileRegex,
            regex: fileRegex,
          },
          {
            label: "Filter by Job",
            inputRef: jobInputRef,
            value: jobFilter,
            setRegex: setJobRegex,
            regex: jobRegex,
          },
        ].map(({ label, inputRef, value, setRegex, regex }) => (
          <TextField
            key={label}
            label={label}
            size="small"
            inputRef={inputRef}
            defaultValue={value}
            slotProps={{
              inputLabel: { shrink: true },
              input: {
                endAdornment: (
                  <RegexButton isRegex={regex} setIsRegex={setRegex} />
                ),
              },
            }}
          />
        ))}
        <ButtonGroup>
          <Button
            variant={useOrFilter ? "outlined" : "contained"}
            onClick={() => setUseOrFilter(false)}
          >
            And
          </Button>
          <Button
            variant={useOrFilter ? "contained" : "outlined"}
            onClick={() => setUseOrFilter(true)}
          >
            Or
          </Button>
        </ButtonGroup>
        <Button type="submit" variant="outlined">
          Filter
        </Button>
        <Button
          type="button"
          variant="outlined"
          color="secondary"
          sx={{ ml: 1 }}
          onClick={() => {
            setFileFilter("");
            setJobFilter("");
            setLabelFilter("");
            setFileRegex(false);
            setJobRegex(false);
            setLabelRegex(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
            if (jobInputRef.current) jobInputRef.current.value = "";
            if (labelInputRef.current) labelInputRef.current.value = "";
          }}
        >
          Clear Filters
        </Button>
      </Box>
      <CommitTimeline data={shas} />
      <Overview
        data={data}
        setFileFilter={(input) => {
          setFileFilter(input);
          setFileRegex(false);
        }}
        setJobFilter={(input) => {
          setJobFilter(input);
          setJobRegex(false);
        }}
        setLabelFilter={(input) => {
          setLabelFilter(input);
          setLabelRegex(false);
        }}
      />
      <Diffs
        data={data}
        setFileFilter={(input) => {
          setFileFilter(input);
          setFileRegex(false);
        }}
        setJobFilter={(input) => {
          setJobFilter(input);
          setJobRegex(false);
        }}
      />
      <Graphs data={data} />
      <Stack spacing={2}>
        <Typography variant="h6">Status Changes</Typography>
        <Typography variant="body1">
          This table lists the tests that were added, removed, started skipping,
          or stopped skipping. This will only show at most 200 entries due to
          API limits.
        </Typography>
        <TestStatus shas={shas} data={data} />
      </Stack>
    </Stack>
  );
}
