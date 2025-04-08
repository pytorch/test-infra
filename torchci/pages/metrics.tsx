import {
  FormControl,
  Grid2,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { GridRenderCellParams } from "@mui/x-data-grid";
import { DateTimePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import ScalarPanel, {
  ScalarPanelWithValue,
} from "components/metrics/panels/ScalarPanel";
import TablePanel from "components/metrics/panels/TablePanel";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { fetcher } from "lib/GeneralUtils";
import { useEffect, useState } from "react";
import useSWR from "swr";

function MasterCommitRedPanel({
  params,
}: {
  params: { [key: string]: string };
}) {
  // Use the dark mode context to determine whether to use the dark theme
  const { darkMode } = useDarkMode();

  const url = `/api/clickhouse/master_commit_red?parameters=${encodeURIComponent(
    JSON.stringify({
      ...params,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const options: EChartsOption = {
    title: {
      text: "Commits red on main, by day",
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
        theme={darkMode ? "dark-hud" : undefined}
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
  queryParams: { [key: string]: any };
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
          valueFormatter: (params: number) => durationDisplay(params),
        },
        { field: "count", headerName: "Count", flex: 1 },
        {
          field: "name",
          headerName: "Name",
          flex: 5,
          // valueFormatter only treat the return value as string, so we need
          // to use renderCell here to get the JSX
          renderCell: (params: GridRenderCellParams<any, string>) => {
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
  setGranularity,
}: {
  startTime: dayjs.Dayjs;
  setStartTime: any;
  stopTime: dayjs.Dayjs;
  setStopTime: any;
  timeRange: any;
  setTimeRange: any;
  setGranularity?: any;
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

    if (setGranularity === undefined) {
      return;
    }

    // When setGranularity is provided, this picker can use it to switch to a
    // bigger granularity automatically when a longer time range is selected.
    // The users can still select a smaller granularity if they want to
    switch (e.target.value as number) {
      case 1:
      case 3:
      case 7:
      case 14:
        setGranularity("hour");
        break;
      case 30:
        setGranularity("day");
        break;
      case 90:
      case 180:
      case 365:
        setGranularity("week");
        break;
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

/**
 * Allows the user to pick the experiment metrics.
 */
export function ExperimentPicker({
  experimentName,
  setExperimentName,
}: {
  experimentName: string;
  setExperimentName: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setExperimentName(e.target.value as string);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="experiment-picker-select-label">Experiment</InputLabel>
        <Select
          defaultValue={experimentName}
          label="Experiment Name"
          labelId="experiment-picker-select-label"
          onChange={handleChange}
        >
          <MenuItem value={"ephemeral"}>ephemeral</MenuItem>
        </Select>
      </FormControl>
    </>
  );
}

function WorkflowDuration({
  percentile,
  timeParams,
  workflowNames,
}: {
  percentile: number;
  timeParams: { [key: string]: string };
  workflowNames: string[];
}) {
  let title: string = `p${percentile * 100} ${workflowNames.join(", ")} TTS`;
  let queryName: string = "workflow_duration_percentile";

  // -1 is the specical case where we will show the avg instead
  if (percentile === -1) {
    title = `avg ${workflowNames.join(", ")} TTS`;
    queryName = queryName.replace("percentile", "avg");
  }

  return (
    <ScalarPanel
      title={title}
      queryName={queryName}
      metricName={"duration_sec"}
      valueRenderer={(value) => durationDisplay(value)}
      queryParams={{
        ...timeParams,
        workflowNames: workflowNames,
        percentile,
      }}
      badThreshold={(value) => value > 60 * 60 * 4} // 3 hours
    />
  );
}

function JobsDuration({
  title,
  branchName,
  queryName,
  metricName,
  percentile,
  timeParams,
}: {
  title: string;
  branchName: string;
  queryName: string;
  metricName: string;
  percentile: number;
  timeParams: { [key: string]: string };
}) {
  let metricHeaderName: string = `p${percentile * 100}`;
  let queryParams = {
    ...timeParams,
    branch: branchName,
    percentile: percentile,
  };

  // -1 is the specical case where we will show the avg instead
  if (percentile === -1) {
    metricHeaderName = "avg";
    queryName = queryName.replace("percentile", "avg");
  }

  return (
    <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
      <TTSPanel
        title={title}
        queryName={queryName}
        queryParams={queryParams}
        metricName={metricName}
        metricHeaderName={metricHeaderName}
        branchName={branchName}
      />
    </Grid2>
  );
}

const ROW_HEIGHT = 375;

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);

  const timeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const [ttsPercentile, setTtsPercentile] = useState<number>(0.5);
  const [experimentName, setExperimentName] = useState<string>("ephemeral");

  // Split the aggregated red % into broken trunk and flaky red %
  const queryName = "master_commit_red_avg";

  // Query both broken trunk and flaky red % in one query to some
  // save CPU usage. This query is quite expensive to run
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify({
      ...timeParams,
      // TODO (huydhn): Figure out a way to have default parameters for ClickHouse queries
      workflowNames: ["lint", "pull", "trunk"],
    })
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

  // The new names are fixed at build-docs-${{ DOC_TYPE }}-${{ PUSHED }}. The PUSHED parameter will always be
  // true here because docs are pushed to GitHub, for example, nightly
  const docsJobNames = [
    "docs push / build-docs-python-true",
    "docs push / build-docs-cpp-true",
    "docs push / build-docs-functorch-true",
  ];

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

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <MasterCommitRedPanel params={timeParams} />
        </Grid2>

        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanelWithValue
              title={"% commits red on main (broken trunk)"}
              value={brokenTrunkRed}
              valueRenderer={(value) => (value * 100).toFixed(1) + "%"}
              badThreshold={(value) => value > 0.2}
            />
            <ScalarPanelWithValue
              title={"% commits red on main (flaky)"}
              value={flakyRed}
              valueRenderer={(value) => (value * 100).toFixed(1) + "%"}
              badThreshold={(value) => value > 0.2}
            />
          </Stack>
        </Grid2>

        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanel
              title={"% force merges due to failed PR checks"}
              queryName={"weekly_force_merge_stats"}
              metricName={"metric"}
              valueRenderer={(value) => value.toFixed(1) + "%"}
              queryParams={{
                ...timeParams,
                merge_type: "Failure",
                one_bucket: true,
                granularity: "week", // Not used but ClickHouse requires it
              }}
              badThreshold={(value) => value > 8.5}
            />
            <ScalarPanel
              title={"% force merges due to impatience"}
              queryName={"weekly_force_merge_stats"}
              metricName={"metric"}
              valueRenderer={(value) => value.toFixed(1) + "%"}
              queryParams={{
                ...timeParams,
                merge_type: "Impatience",
                one_bucket: true,
                granularity: "week", // Not used but ClickHouse requires it
              }}
              badThreshold={(value) => value > 10}
            />
          </Stack>
        </Grid2>
        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanel
              title={"Time to Red Signal (p90 TTRS - mins)"}
              queryName={"ttrs_percentiles"}
              metricName={"custom"}
              valueRenderer={(value) => value}
              queryParams={{
                ...timeParams,
                one_bucket: true,
                percentile_to_get: 0.9,
                workflow: "pull",
              }}
              badThreshold={(value) => value > 50}
            />
            <ScalarPanel
              title={"Time to Red Signal (p75 TTRS - mins)"}
              queryName={"ttrs_percentiles"}
              metricName={"custom"}
              valueRenderer={(value) => value}
              queryParams={{
                ...timeParams,
                one_bucket: true,
                percentile_to_get: 0.75,
                workflow: "pull",
              }}
              badThreshold={(value) => value > 40}
            />
          </Stack>
        </Grid2>
        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanel
              title={"viable/strict lag"}
              queryName={"strict_lag_sec"}
              metricName={"strict_lag_sec"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={{
                repo: "pytorch",
                owner: "pytorch",
                head: "refs/heads/main",
              }}
              badThreshold={(value) => value > 60 * 60 * 6} // 6 hours
            />
            <ScalarPanel
              title={"# disabled tests"}
              queryName={"disabled_test_total"}
              metricName={"number_of_open_disabled_tests"}
              valueRenderer={(value) => value}
              queryParams={{ state: "open" }}
              badThreshold={(_) => false} // we haven't decided on the threshold here yet
            />
          </Stack>
        </Grid2>

        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanel
              title={"Last main push"}
              queryName={"last_branch_push"}
              metricName={"push_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={{ branch: "refs/heads/main" }}
              badThreshold={(_) => false} // never bad
            />
            <ScalarPanel
              title={"Last nightly push"}
              queryName={"last_branch_push"}
              metricName={"push_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={{ branch: "refs/heads/nightly" }}
              badThreshold={(value) => value > 3 * 24 * 60 * 60} // 3 day
            />
          </Stack>
        </Grid2>

        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanel
              title={"Last docker build"}
              queryName={"last_successful_workflow"}
              metricName={"last_success_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={{
                workflowName: "docker-builds",
              }}
              badThreshold={(value) => value > 10 * 24 * 60 * 60} // 10 day
            />
            <ScalarPanel
              title={"Last docs push"}
              queryName={"last_successful_jobs"}
              metricName={"last_success_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              queryParams={{
                jobNames: docsJobNames,
              }}
              badThreshold={(value) => value > 3 * 24 * 60 * 60} // 3 day
            />
          </Stack>
        </Grid2>

        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanel
              title={"# reverts"}
              queryName={"reverts"}
              metricName={"num"}
              valueRenderer={(value: string) => value}
              queryParams={timeParams}
              badThreshold={(value) => value > 10}
            />
            <ScalarPanel
              title={"# commits"}
              queryName={"num_commits_master"}
              metricName={"num"}
              valueRenderer={(value) => value}
              queryParams={timeParams}
              badThreshold={(_) => false}
            />
          </Stack>
        </Grid2>

        <Grid2
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <WorkflowDuration
              percentile={ttsPercentile}
              timeParams={timeParams}
              workflowNames={["pull", "trunk"]}
            />
          </Stack>
        </Grid2>

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <TablePanel
            title={"Queued Jobs by Machine Type"}
            queryName={"queued_jobs_by_label"}
            queryParams={{}}
            columns={[
              { field: "count", headerName: "Count", flex: 1 },
              {
                field: "avg_queue_s",
                headerName: "Queue time",
                flex: 1,
                valueFormatter: (params: number) => durationDisplay(params),
              },
              { field: "machine_type", headerName: "Machine Type", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.machine_type }}
          />
        </Grid2>

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <TablePanel
            title={"Jobs in Queue"}
            queryName={"queued_jobs"}
            queryParams={{}}
            columns={[
              {
                field: "queue_s",
                headerName: "Time in Queue",
                flex: 1,
                valueFormatter: (params: number) => durationDisplay(params),
              },
              { field: "machine_type", headerName: "Machine Type", flex: 1 },
              {
                field: "name",
                headerName: "Job Name",
                flex: 4,
                renderCell: (params: GridRenderCellParams<any, string>) => (
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
        </Grid2>

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Queue times historical"}
            queryName={"queue_times_historical"}
            queryParams={{
              ...timeParams,
              granlarity: "hour",
            }}
            granularity={"hour"}
            groupByFieldName={"machine_type"}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={"avg_queue_s"}
            yAxisRenderer={durationDisplay}
          />
        </Grid2>

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Workflow load per Day"}
            queryName={"workflow_load"}
            queryParams={{ ...timeParams, repo: "pytorch/pytorch" }}
            granularity={"hour"}
            groupByFieldName={"name"}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={"count"}
            yAxisLabel={"workflows started"}
            yAxisRenderer={(value) => value}
          />
        </Grid2>

        <JobsDuration
          title={"Job time-to-signal, all branches"}
          branchName={"%"}
          queryName={"tts_percentile"}
          metricName={"tts_sec"}
          percentile={ttsPercentile}
          timeParams={timeParams}
        />

        <JobsDuration
          title={"Job time-to-signal, main-only"}
          branchName={"main"}
          queryName={"tts_percentile"}
          metricName={"tts_sec"}
          percentile={ttsPercentile}
          timeParams={timeParams}
        />

        <JobsDuration
          title={"Job duration, all branches"}
          branchName={"%"}
          queryName={"job_duration_percentile"}
          metricName={"duration_sec"}
          percentile={ttsPercentile}
          timeParams={timeParams}
        />

        <JobsDuration
          title={"Job duration, main-only"}
          branchName={"main"}
          queryName={"job_duration_percentile"}
          metricName={"duration_sec"}
          percentile={ttsPercentile}
          timeParams={timeParams}
        />

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <TablePanel
            title={"Failed Jobs Log Classifications"}
            queryName={"log_captures_count"}
            queryParams={timeParams}
            columns={[
              { field: "num", headerName: "Count", flex: 1 },
              { field: "example", headerName: "Example", flex: 4 },
              {
                field: "captures",
                headerName: "Captures",
                flex: 4,
                renderCell: (params: GridRenderCellParams<any, string>) => {
                  const url = params.value
                    ? `failure?failureCaptures=${encodeURIComponent(
                        JSON.stringify(params.row.captures)
                      )}`
                    : "failure";
                  return <a href={url}>{params.value}</a>;
                },
              },
            ]}
            dataGridProps={{
              getRowId: (el: any) =>
                el.captures ? JSON.stringify(el.captures) : "null",
            }}
          />
        </Grid2>

        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Number of new disabled tests"}
            queryName={"disabled_test_historical"}
            queryParams={{ ...timeParams, repo: "pytorch/pytorch" }}
            granularity={"day"}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={"number_of_new_disabled_tests"}
            yAxisRenderer={(value) => value}
            additionalOptions={{ yAxis: { scale: true } }}
          />
        </Grid2>

        <Grid2 size={{ xs: 12 }}>
          <br />
          <br />
          <Typography variant="h3" gutterBottom>
            Linux Foundation vs Meta Fleets
          </Typography>
          <p>
            These panels show the <b>delta</b> between states of the same job
            run on the Linux Foundation vs the Meta fleets.
          </p>
        </Grid2>

        <Grid2 size={{ xs: 12 }} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Percentage of jobs rolled over to Linux Foundation"}
            queryName={"lf_rollover_percentage"}
            queryParams={{ ...timeParams, days_ago: timeRange }}
            granularity={"hour"}
            timeFieldName={"bucket"}
            yAxisFieldName={"percentage"}
            groupByFieldName={"fleet"}
            yAxisRenderer={(value) => value.toFixed(2).toString() + "%"}
          />
        </Grid2>

        <Grid2 size={{ xs: 12 }}>
          <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
            <Typography variant="h3" gutterBottom>
              Percentage of jobs running on experiment
            </Typography>
            <ExperimentPicker
              experimentName={experimentName}
              setExperimentName={setExperimentName}
            />
          </Stack>
          <p>
            This pannel shows the % of jobs that are running the selected
            experiment in the dropbox.
          </p>
        </Grid2>

        <Grid2 size={{ xs: 12 }} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"Percentage of jobs running on experiment"}
            queryName={"experiment_rollover_percentage"}
            queryParams={{
              ...timeParams,
              days_ago: timeRange,
              experiment_name: experimentName,
            }}
            granularity={"hour"}
            timeFieldName={"bucket"}
            yAxisFieldName={"percentage"}
            groupByFieldName={"fleet"}
            yAxisRenderer={(value) => value.toFixed(2).toString() + "%"}
          />
        </Grid2>
      </Grid2>
    </div>
  );
}
