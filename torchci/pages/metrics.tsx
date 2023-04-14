import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import {
  GridRenderCellParams,
  GridValueFormatterParams,
} from "@mui/x-data-grid";
import useSWR from "swr";
import {
  Grid,
  Paper,
  TextField,
  Typography,
  Stack,
  Skeleton,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";
import { LocalizationProvider, DateTimePicker } from "@mui/x-date-pickers";

import { useEffect, useState } from "react";

import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import ScalarPanel, {
  ScalarPanelWithValue,
} from "components/metrics/panels/ScalarPanel";
import TablePanel from "components/metrics/panels/TablePanel";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";

function MasterJobsRedPanel({ params }: { params: RocksetParam[] }) {
  const url = `/api/query/metrics/master_jobs_red?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const options: EChartsOption = {
    title: { text: "% master jobs by red" },
    grid: { top: 48, right: 8, bottom: 24, left: 36 },
    dataset: { source: data },
    xAxis: { type: "time" },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: (value: number) => {
          return (value * 100).toString() + "%";
        },
      },
    },
    series: [
      {
        type: "bar",
        encode: {
          x: "granularity_bucket",
          y: "red",
        },
      },
    ],
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: any) => {
        return (value * 100).toFixed(2) + "%";
      },
    },
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}

function MasterCommitRedPanel({ params }: { params: RocksetParam[] }) {
  const url = `/api/query/metrics/master_commit_red?parameters=${encodeURIComponent(
    JSON.stringify([
      ...params,
      {
        name: "timezone",
        type: "string",
        value: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    ])
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const options: EChartsOption = {
    title: {
      text: "Commits red on master, by day",
      subtext: "Based on workflows which block viable/strict upgrade",
    },
    grid: { top: 60, right: 8, bottom: 24, left: 36 },
    dataset: { source: data },
    xAxis: { type: "category" },
    yAxis: {
      type: "value",
    },
    series: [
      {
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "green",
        },
      },
      {
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "red",
        },
      },
      {
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "pending",
        },
      },
    ],
    color: ["#3ba272", "#ee6666", "#f2d643"],
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const red = params[0].data.red;
        const green = params[0].data.green;
        const pending = params[0].data.pending;
        const total = params[0].data.total;

        const redPct = ((red / total) * 100).toFixed(2) + "%";
        const greenPct = ((green / total) * 100).toFixed(2) + "%";
        const pendingPct = ((pending / total) * 100).toFixed(2) + "%";
        return `Red: ${red} (${redPct})<br/>Green: ${green} (${greenPct})<br/>Pending: ${pending} (${pendingPct})<br/>Total: ${total}`;
      },
    },
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}

// Specialized version of TablePanel for TTS metrics.
function TTSPanel({
  title,
  queryName,
  queryParams,
  metricHeaderName,
  metricName,
  branchName,
}: {
  title: string;
  queryName: string;
  queryParams: RocksetParam[];
  metricHeaderName: string;
  metricName: string;
  branchName: string;
}) {
  return (
    <TablePanel
      title={title}
      queryName={queryName}
      queryParams={queryParams}
      columns={[
        {
          field: metricName,
          headerName: metricHeaderName,
          flex: 1,
          valueFormatter: (params: GridValueFormatterParams<number>) =>
            durationDisplay(params.value),
        },
        { field: "count", headerName: "Count", flex: 1 },
        {
          field: "name",
          headerName: "Name",
          flex: 5,
          // valueFormatter only treat the return value as string, so we need
          // to use renderCell here to get the JSX
          renderCell: (params: GridRenderCellParams<string>) => {
            const jobName = params.value;
            if (jobName === undefined) {
              return `Invalid job name ${jobName}`;
            }

            const encodedJobName = encodeURIComponent(jobName);
            const encodedBranchName = encodeURIComponent(branchName);
            return (
              <a
                href={`/tts/pytorch/pytorch/${encodedBranchName}?jobName=${encodedJobName}`}
              >
                {jobName}
              </a>
            );
          },
        },
      ]}
      dataGridProps={{ getRowId: (el: any) => el.name }}
    />
  );
}

function TimePicker({ label, value, setValue }: any) {
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <DateTimePicker
        renderInput={(props) => <TextField {...props} />}
        label={label}
        value={value}
        onChange={(newValue) => {
          setValue(newValue);
        }}
      />
    </LocalizationProvider>
  );
}

/**
 * Allows the user to pick from common time ranges, or manually set their own.
 */
export function TimeRangePicker({
  startTime,
  setStartTime,
  stopTime,
  setStopTime,
  timeRange,
  setTimeRange,
}: {
  startTime: dayjs.Dayjs;
  setStartTime: any;
  stopTime: dayjs.Dayjs;
  setStopTime: any;
  timeRange: any;
  setTimeRange: any;
}) {
  function updateTimeRange() {
    if (timeRange === -1) {
      return;
    }
    const startTime = dayjs().subtract(timeRange, "day");
    setStartTime(startTime);
    const stopTime = dayjs();
    setStopTime(stopTime);
  }

  // Keep the current time range updated.
  useEffect(() => {
    const id = setInterval(updateTimeRange, 1000 * 60 * 5 /*5 minutes*/);
    return () => clearInterval(id);
  }, [timeRange, updateTimeRange]);

  function handleChange(e: SelectChangeEvent<number>) {
    setTimeRange(e.target.value as number);
    // The user wants to set a custom time, don't change the start and stop
    // time.
    if (e.target.value !== -1) {
      const startTime = dayjs().subtract(e.target.value as number, "day");
      setStartTime(startTime);
      const stopTime = dayjs();
      setStopTime(stopTime);
    }
  }

  return (
    <>
      <FormControl>
        <InputLabel id="time-picker-select-label">Time Range</InputLabel>
        <Select
          value={timeRange}
          label="Time Range"
          labelId="time-picker-select-label"
          onChange={handleChange}
        >
          <MenuItem value={1}>Last 1 Day</MenuItem>
          <MenuItem value={3}>Last 3 Days</MenuItem>
          <MenuItem value={7}>Last 7 Days</MenuItem>
          <MenuItem value={14}>Last 14 Days</MenuItem>
          <MenuItem value={30}>Last Month</MenuItem>
          <MenuItem value={90}>Last Quarter</MenuItem>
          <MenuItem value={180}>Last Half</MenuItem>
          <MenuItem value={365}>Last Year</MenuItem>
          <MenuItem value={-1}>Custom</MenuItem>
        </Select>
      </FormControl>
      {timeRange === -1 && (
        <>
          <TimePicker
            label={"Start Time"}
            value={startTime}
            setValue={setStartTime}
          />
          <TimePicker
            label={"Stop Time"}
            value={stopTime}
            setValue={setStopTime}
          />
        </>
      )}
    </>
  );
}

/**
 * Allows the user to pick the TTS metrics.
 */
export function TtsPercentilePicker({
  ttsPercentile,
  setTtsPercentile,
}: {
  ttsPercentile: number;
  setTtsPercentile: any;
}) {
  function handleChange(e: SelectChangeEvent<number>) {
    setTtsPercentile(e.target.value as number);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="tts-percentile-picker-select-label">
          Percentile
        </InputLabel>
        <Select
          defaultValue={ttsPercentile}
          label="Percentile"
          labelId="tts-percentile-picker-select-label"
          onChange={handleChange}
        >
          <MenuItem value={-1.0}>avg</MenuItem>
          <MenuItem value={0.5}>p50</MenuItem>
          <MenuItem value={0.9}>p90</MenuItem>
          <MenuItem value={0.95}>p95</MenuItem>
          <MenuItem value={0.99}>p99</MenuItem>
          <MenuItem value={1.0}>p100</MenuItem>
        </Select>
      </FormControl>
    </>
  );
}

function WorkflowDuration({
  percentileParam,
  timeParams,
  workflowNames,
}: {
  percentileParam: RocksetParam;
  timeParams: RocksetParam[];
  workflowNames: string[];
}) {
  const ttsPercentile = percentileParam.value;

  let title: string = `p${ttsPercentile * 100} ${workflowNames.join(
    ", "
  )} workflows duration`;
  let queryName: string = "workflow_duration_percentile";

  // -1 is the specical case where we will show the avg instead
  if (ttsPercentile === -1) {
    title = `avg ${workflowNames.join(", ")} workflow duration`;
    queryName = queryName.replace("percentile", "avg");
  }

  return (
    <ScalarPanel
      title={title}
      queryName={queryName}
      metricName={"duration_sec"}
      valueRenderer={(value) => durationDisplay(value)}
      queryParams={[
        {
          name: "workflowNames",
          type: "string",
          value: workflowNames.join(","),
        },
        percentileParam,
        ...timeParams,
      ]}
      badThreshold={(value) => value > 60 * 60 * 4} // 3 hours
    />
  );
}

function JobsDuration({
  title,
  branchName,
  queryName,
  metricName,
  percentileParam,
  timeParams,
}: {
  title: string;
  branchName: string;
  queryName: string;
  metricName: string;
  percentileParam: RocksetParam;
  timeParams: RocksetParam[];
}) {
  const ttsPercentile = percentileParam.value;

  let metricHeaderName: string = `p${ttsPercentile * 100}`;
  let queryParams: RocksetParam[] = [
    {
      name: "branch",
      type: "string",
      value: branchName,
    },
    percentileParam,
    ...timeParams,
  ];

  // -1 is the specical case where we will show the avg instead
  if (ttsPercentile === -1) {
    metricHeaderName = "avg";
    queryName = queryName.replace("percentile", "avg");
  }

  return (
    <Grid item xs={6} height={ROW_HEIGHT}>
      <TTSPanel
        title={title}
        queryName={queryName}
        queryParams={queryParams}
        metricName={metricName}
        metricHeaderName={metricHeaderName}
        branchName={branchName}
      />
    </Grid>
  );
}

const ROW_HEIGHT = 340;

function getCommitRedMetrics(queryParams: RocksetParam[]) {}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);

  const timeParams: RocksetParam[] = [
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
  ];

  const [ttsPercentile, setTtsPercentile] = useState<number>(0.5);

  const percentileParam: RocksetParam = {
    name: "percentile",
    type: "float",
    value: ttsPercentile,
  };

  var numberFormat = Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  });

  // Split the aggregated red % into broken trunk and flaky red %
  const queryCollection = "metrics";
  const queryName = "master_commit_red_avg";

  // Query both broken trunk and flaky red % in one query to some
  // save CPU usage. This query is quite expensive to run
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(timeParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  const brokenTrunkRed =
    data === undefined || data.length === 0
      ? undefined
      : data[0]["broken_trunk_red"];
  const flakyRed =
    data === undefined || data.length === 0 ? undefined : data[0]["flaky_red"];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch CI Metrics
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
        <TtsPercentilePicker
          ttsPercentile={ttsPercentile}
          setTtsPercentile={setTtsPercentile}
        />
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={6} height={ROW_HEIGHT}>
          <MasterJobsRedPanel params={timeParams} />
        </Grid>
        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <ScalarPanelWithValue
              title={"% commits red on master (broken trunk)"}
              value={brokenTrunkRed}
              valueRenderer={(value) => (value * 100).toFixed(1) + "%"}
              badThreshold={(value) => value > 0.2}
            />
            <ScalarPanel
              title={"# commits"}
              queryName={"num_commits_master"}
              queryCollection={"commons"}
              metricName={"num"}
              valueRenderer={(value) => value}
              queryParams={timeParams}
              badThreshold={(_) => false}
            />
          </Stack>
        </Grid>

        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <ScalarPanelWithValue
              title={"% commits red on master (flaky)"}
              value={flakyRed}
              valueRenderer={(value) => (value * 100).toFixed(1) + "%"}
              badThreshold={(value) => value > 0.2}
            />
            <ScalarPanel
              title={"# reverts"}
              queryName={"reverts"}
              metricName={"num"}
              valueRenderer={(value: string) => value}
              queryParams={timeParams}
              badThreshold={(value) => value > 10}
            />
          </Stack>
        </Grid>

        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <ScalarPanel
              title={"% force merges due to failed PR checks"}
              queryName={"force_merge_red_avg"}
              metricName={"force_merges_red"}
              valueRenderer={(value) => (value * 100).toFixed(1) + "%"}
              queryParams={timeParams}
              badThreshold={(value) => value > 0.2}
            />
            <WorkflowDuration
              percentileParam={percentileParam}
              timeParams={timeParams}
              workflowNames={["pull", "trunk"]}
            />
          </Stack>
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <MasterCommitRedPanel params={timeParams} />
        </Grid>

        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <ScalarPanel
              title={"viable/strict lag"}
              queryName={"strict_lag_sec"}
              metricName={"strict_lag_sec"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={[]}
              badThreshold={(value) => value > 60 * 60 * 6} // 6 hours
            />
            <ScalarPanel
              title={"# disabled tests"}
              queryName={"disabled_test_total"}
              metricName={"number_of_open_disabled_tests"}
              valueRenderer={(value) => value}
              queryParams={[]}
              badThreshold={(_) => false} // we haven't decided on the threshold here yet
            />
          </Stack>
        </Grid>

        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <ScalarPanel
              title={"Last master push"}
              queryName={"last_branch_push"}
              metricName={"push_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={[
                {
                  name: "branch",
                  type: "string",
                  value: "refs/heads/master",
                },
              ]}
              badThreshold={(_) => false} // never bad
            />
            <ScalarPanel
              title={"Last nightly push"}
              queryName={"last_branch_push"}
              metricName={"push_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={[
                {
                  name: "branch",
                  type: "string",
                  value: "refs/heads/nightly",
                },
              ]}
              badThreshold={(value) => value > 3 * 24 * 60 * 60} // 3 day
            />
          </Stack>
        </Grid>

        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <ScalarPanel
              title={"Last docker build"}
              queryName={"last_successful_workflow"}
              metricName={"last_success_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={[
                {
                  name: "workflowName",
                  type: "string",
                  value: "docker-builds",
                },
              ]}
              badThreshold={(value) => value > 10 * 24 * 60 * 60} // 10 day
            />
            <ScalarPanel
              title={"Last docs push"}
              queryName={"last_successful_jobs"}
              metricName={"last_success_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={[
                {
                  name: "jobNames",
                  type: "string",
                  value:
                    // The new names are fixed at build-docs-${{ DOC_TYPE }}-${{ PUSHED }}. The PUSHED parameter will always be
                    // true here because docs are pushed to GitHub, for example, nightly
                    "docs push / build-docs-python-true;docs push / build-docs-cpp-true;docs push / build-docs-functorch-true",
                },
              ]}
              badThreshold={(value) => value > 3 * 24 * 60 * 60} // 3 day
            />
          </Stack>
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Queued Jobs by Machine Type"}
            queryName={"queued_jobs_by_label"}
            queryParams={[]}
            columns={[
              { field: "count", headerName: "Count", flex: 1 },
              {
                field: "avg_queue_s",
                headerName: "Queue time",
                flex: 1,
                valueFormatter: (params: GridValueFormatterParams<number>) =>
                  durationDisplay(params.value),
              },
              { field: "machine_type", headerName: "Machine Type", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.machine_type }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Jobs in Queue"}
            queryName={"queued_jobs"}
            queryParams={[]}
            columns={[
              {
                field: "queue_s",
                headerName: "Time in Queue",
                flex: 1,
                valueFormatter: (params: GridValueFormatterParams<number>) =>
                  durationDisplay(params.value),
              },
              { field: "machine_type", headerName: "Machine Type", flex: 1 },
              {
                field: "name",
                headerName: "Job Name",
                flex: 4,
                renderCell: (params: GridRenderCellParams<string>) => (
                  <a href={params.row.html_url}>{params.value}</a>
                ),
              },
              { field: "html_url" },
            ]}
            dataGridProps={{
              columnVisibilityModel: {
                // Hide this column, since we turn it into a link
                html_url: false,
              },
              getRowId: (el: any) => el.html_url,
            }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Queue times historical"}
            queryName={"queue_times_historical"}
            queryParams={[
              {
                name: "timezone",
                type: "string",
                value: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
              ...timeParams,
            ]}
            granularity={"hour"}
            groupByFieldName={"machine_type"}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={"avg_queue_s"}
            yAxisRenderer={durationDisplay}
          />
        </Grid>

        <JobsDuration
          title={"Job time-to-signal, all branches"}
          branchName={"%"}
          queryName={"tts_percentile"}
          metricName={"tts_sec"}
          percentileParam={percentileParam}
          timeParams={timeParams}
        />

        <JobsDuration
          title={"Job time-to-signal, master-only"}
          branchName={"master"}
          queryName={"tts_percentile"}
          metricName={"tts_sec"}
          percentileParam={percentileParam}
          timeParams={timeParams}
        />

        <JobsDuration
          title={"Job duration, all branches"}
          branchName={"%"}
          queryName={"job_duration_percentile"}
          metricName={"duration_sec"}
          percentileParam={percentileParam}
          timeParams={timeParams}
        />

        <JobsDuration
          title={"Job duration, master-only"}
          branchName={"master"}
          queryName={"job_duration_percentile"}
          metricName={"duration_sec"}
          percentileParam={percentileParam}
          timeParams={timeParams}
        />

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Number of tests run"}
            queryName={"num_tests_run"}
            queryParams={[...timeParams]}
            granularity={"minute"}
            groupByFieldName={"workflow_name"}
            timeFieldName={"push_event_time"}
            yAxisFieldName={"avg_num_tests"}
            yAxisRenderer={(value) => numberFormat.format(parseInt(value))}
            additionalOptions={{ yAxis: { scale: true } }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Number of new disabled tests"}
            queryName={"disabled_test_historical"}
            queryParams={[...timeParams]}
            granularity={"day"}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={"number_of_new_disabled_tests"}
            yAxisRenderer={(value) => value}
            additionalOptions={{ yAxis: { scale: true } }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Failed Jobs Log Classifications"}
            queryName={"log_captures_count"}
            queryCollection={"metrics"}
            queryParams={[...timeParams]}
            columns={[
              { field: "num", headerName: "Count", flex: 1 },
              { field: "example", headerName: "Example", flex: 4 },
              {
                field: "search_string",
                headerName: "Captures",
                flex: 4,
                renderCell: (params: GridRenderCellParams<string>) => {
                  const url = params.value
                    ? `failure/${encodeURIComponent(params.row.search_string)}`
                    : "failure/";
                  return <a href={url}>{params.value}</a>;
                },
              },
            ]}
            dataGridProps={{
              getRowId: (el: any) =>
                el.search_string ? el.search_string : "null",
            }}
          />
        </Grid>
      </Grid>
    </div>
  );
}
