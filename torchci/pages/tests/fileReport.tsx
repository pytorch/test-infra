import {
  Box,
  Button,
  ButtonGroup,
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
import LoadingPage from "components/common/LoadingPage";
import RegexButton from "components/common/RegexButton";
import { durationDisplay } from "components/common/TimeUtils";
import ReactECharts from "echarts-for-react";
import _ from "lodash";
import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";

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

function Diffs({
  data,
  setFileFilter,
  setJobFilter,
}: {
  data: { [key: string]: any }[];
  setFileFilter: (v: string) => void;
  setJobFilter: (v: string) => void;
}) {
  const groupByOptions = {};
  // Compute diffs for every row (except the earliest) in each (file_name, job_name) group
  const groupedDiff = _.groupBy(data, (d) => `${d.file_name}|||${d.job_name}`);
  // Map from id (row) to diff object for every row (except the first in group)
  const rowDiffs: Record<string, any> = {};
  Object.entries(groupedDiff).forEach(([key, arr]) => {
    // Sort by push_date ascending (oldest to newest)
    const sorted = _.sortBy(arr, (d) => d.push_date);
    for (let i = 1; i < sorted.length; ++i) {
      const curr = sorted[i];
      const prev = sorted[i - 1];
      function diff(field: string) {
        if (!curr || !prev) return null;
        return (curr[field] || 0) - (prev[field] || 0);
      }
      rowDiffs[curr.id] = {
        count_diff: diff("count"),
        cost_diff: diff("cost"),
        time_diff: diff("time"),
        skipped_diff: diff("skipped"),
        errors_diff: diff("errors"),
        failures_diff: diff("failures"),
        successes_diff: diff("successes"),
      };
    }
  });

  const columns: GridColDef[] = [
    { field: "sha", headerName: "SHA", flex: 1 },
    {
      field: "push_date",
      headerName: "Push Date",
      flex: 1,
      renderCell: (params: any) => formatTimestamp(params.value),
    },
    {
      field: "file_name",
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
      field: "job_name",
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
        combination. The Δ (delta) columns show the change in each metric
        compared to the previous commit for the same file and job. Double click
        on the file or job to filter by that value. Highlighted cells are large
        changes (either by percent or absolute value) and may indicate
        regressions or improvements.
      </Typography>

      <Typography variant="body1">
        Pricing is approximate and per commit. Some pricing data may be missing
        (ex mac, rocm), in those cases the cost will be 0.
      </Typography>
      <Box height={"600px"}>
        <DataGrid
          density="compact"
          rows={data.map((row) => ({
            ...row,
            ...(rowDiffs[row.id] || {}),
          }))}
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
      field: "file_name",
      buttonText: "Group by File",
      onDoubleClick: (value: any) => setFileFilter(value),
      onDoubleClickHelpText: "Double-click to filter by this file",
      groupByKey: (v: any) => [v.file_name],
    },
    job: {
      headerName: "Job",
      field: "job_name",
      buttonText: "Group by Job",
      onDoubleClick: (value: any) => setJobFilter(value),
      onDoubleClickHelpText: "Double-click to filter by this job",
      groupByKey: (v: any) => [v.job_name],
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
    // Sum within sha
    const summedBySha = _.map(_.groupBy(rows, "sha"), (shaRows) => {
      return _.reduce(
        shaRows,
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
    });
    // the reduce across shas for average
    return _.reduce(
      summedBySha,
      (acc, summed) => {
        acc.count += summed.count;
        acc.time += summed.time;
        acc.cost += summed.cost;
        acc.skipped += summed.skipped;
        acc.frequency += summed.frequency;
        return acc;
      },
      {
        id: rows[0].id,
        file_name: rows[0].file_name,
        job_name: rows[0].job_name,
        labels: key,
        count: 0,
        time: 0,
        cost: 0,
        skipped: 0,
        frequency: 0,
      }
    );
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

function CommitInfo({ data }: { data: any[] }) {
  const commits = _.reduce(
    data,
    (acc, row) => {
      const key = row.sha;
      acc[key] = row.push_date;
      return acc;
    },
    {} as Record<string, any[]>
  );
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Commits</Typography>
      <Typography variant="body1">
        These are the commits that are included in the report.
      </Typography>
      <DataGrid
        density="compact"
        rows={Object.entries(commits).map(([sha, pushDate]) => ({
          id: sha,
          push_date: pushDate,
        }))}
        columns={[
          { field: "id", headerName: "SHA", flex: 1 },
          {
            field: "push_date",
            headerName: "Push Date",
            flex: 1,
            renderCell: (params: any) => formatTimestamp(params.value),
          },
        ]}
        initialState={{
          sorting: {
            sortModel: [{ field: "push_date", sort: "asc" }],
          },
        }}
      />
    </Stack>
  );
}

function Graphs({ data }: { data: any[] }) {
  // Map selector value to field and label
  const groupByOptions = {
    file: {
      getGroupByField: (d: any) => d.file_name,
      groupByButtonText: "Group by File",
    },
    job: {
      getGroupByField: (d: any) => d.job_name,
      groupByButtonText: "Group by Job",
    },
    filejob: {
      getGroupByField: (d: any) => `${d.job_name} | ${d.file_name}`,
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

function TestStatus({ data }: { data: { [key: string]: any }[] }) {
  const columns: any[] = [
    { field: "status", headerName: "Status", flex: 1 },
    { field: "file_name", headerName: "File", flex: 4 },
    { field: "test_name", headerName: "Test", flex: 4 },
    { field: "job_name", headerName: "Job", flex: 4 },
    { field: "sha", headerName: "SHA", flex: 1 },
    {
      field: "push_date",
      headerName: "Push Date",
      flex: 1,
      renderCell: (params: any) => formatTimestamp(params.value),
    },
  ];

  return (
    <Box height={"600px"}>
      <DataGrid density="compact" rows={[...data]} columns={columns} />
    </Box>
  );
}

// Custom hook to fetch real data from the local JSON file
function useData(link: string) {
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    fetch(link)
      .then((response) => response.text())
      .then((text) => {
        const final = [];
        for (const line of text.split("\n")) {
          if (line.trim()) {
            final.push(...JSON.parse(line));
          }
        }
        setData(final.map((item, index) => ({ ...item, id: index })));
      });
  }, [link]);
  return data;
}

export default function Page() {
  const [fileFilter, setFileFilter] = useState("");
  const [jobFilter, setJobFilter] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [fileRegex, setFileRegex] = useState(false);
  const [jobRegex, setJobRegex] = useState(false);
  const [labelRegex, setLabelRegex] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jobInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

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
  let data = useData("/data.json").map((item) => ({
    // Hopefully get rid of this eventually
    ...item,
    file_name: item.file_name.replace(".", "/") + ".py",
  }));
  let statusChangeData = useData("/status_changes.json");

  useEffect(() => {
    if (router.query.label) {
      setLabelFilter(router.query.label as string);
    }
  }, [router.query.label]);

  if (!router.isReady) {
    return <LoadingPage />;
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

  // Filter data by file, job, and label with regex support
  data = data.filter((row) => {
    const fileMatch = matchField(row.file_name, fileFilter, fileRegex);
    const jobMatch = matchField(row.job_name, jobFilter, jobRegex);
    const labelMatch = matchLabel(row.labels, labelFilter, labelRegex);
    return fileMatch && jobMatch && labelMatch;
  });

  // Apply the same file/job/label filter to statusChangeData
  statusChangeData = statusChangeData?.filter((row) => {
    const fileMatch = matchField(row.file_name, fileFilter, fileRegex);
    const jobMatch = matchField(row.job_name, jobFilter, jobRegex);
    const labelMatch = matchLabel(row.labels, labelFilter, labelRegex);
    return fileMatch && jobMatch && labelMatch;
  });

  return (
    <Stack spacing={4}>
      <Typography variant="h5">Test Reports</Typography>
      <Stack spacing={2}>
        <Typography variant="body1">
          This report provides insights into the test files executed over recent
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
      </Stack>
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
      <CommitInfo data={data} />
      <Overview
        data={data}
        setFileFilter={setFileFilter}
        setJobFilter={setJobFilter}
        setLabelFilter={setLabelFilter}
      />
      <Diffs
        data={data}
        setFileFilter={setFileFilter}
        setJobFilter={setJobFilter}
      />
      <Graphs data={data} />
      <Stack spacing={2}>
        <Typography variant="h6">Status Changes</Typography>
        <Typography variant="body1">
          This table lists the tests that were added, removed, started skipping,
          or stopped skipping. This will only show at most 50 entries per commit
          pair due to file size.
        </Typography>
        <TestStatus data={statusChangeData} />
      </Stack>
    </Stack>
  );
}
