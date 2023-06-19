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

import TablePanel from "components/metrics/panels/TablePanel";
import { durationDisplay } from "components/TimeUtils";

function NightlyJobsRedPanel({ params, repo }: { params: RocksetParam[], repo: string }) {

  let repo_p = params.find(({ name }) => name == "repo");
  if(repo_p && repo) repo_p.value = repo; 

  const url = `/api/query/nightlies/nightly_jobs_red?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const options: EChartsOption = {
    title: { text: "% "+repo+" nightly jobs failures" },
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

function ValidationRedPanel({ params, channel }: { params: RocksetParam[], channel: string }) {
  const url = `/api/query/nightlies/validation_jobs_red?parameters=${encodeURIComponent(
    JSON.stringify([
      ...params,
      {
        name: "timezone",
        type: "string",
        value: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      {
        name: "channel",
        type: "string",
        value: channel,
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
      text: channel.charAt(0).toUpperCase()+channel.slice(1)+" validation workflows failures, by day",
      subtext: "Installation of PyTorch, Vision and Audio an smoke test",
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

const ROW_HEIGHT = 340;
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
    {
      name: "repo",
      type: "string",
      value: "pytorch",
    },
  ];

  var numberFormat = Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  });

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Nightly Binaries Metrics
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={6} height={ROW_HEIGHT}>
          <NightlyJobsRedPanel params={timeParams} repo={"pytorch"} />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <NightlyJobsRedPanel params={timeParams} repo={"vision"} />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <NightlyJobsRedPanel params={timeParams} repo={"audio"} />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <NightlyJobsRedPanel params={timeParams} repo={"text"} />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <ValidationRedPanel params={timeParams} channel={"release"} />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <ValidationRedPanel params={timeParams} channel={"nightly"} />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Release failed validation jobs for past 24hrs"}
            queryName={"validation_jobs_red_past_day"}
            queryParams={[{
                name: "channel",
                type: "string",
                value: "release",
              }]}
            queryCollection="nightlies"
            columns={[
              { field: "COUNT", headerName: "Count", flex: 1 },
              { field: "name", headerName: "Name", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.name }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Nightly failed validation jobs for past 24hrs"}
            queryName={"validation_jobs_red_past_day"}
            queryParams={[{
                name: "channel",
                type: "string",
                value: "nightly",
              }]}
            queryCollection="nightlies"
            columns={[
              { field: "COUNT", headerName: "Count", flex: 1 },
              { field: "name", headerName: "Name", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.name }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Nightly PyTorch build jobs for past 24hrs"}
            queryName={"nightly_jobs_red_past_day"}
            queryParams={[{
                name: "repo",
                type: "string",
                value: "pytorch",
              }]}
            queryCollection="nightlies"
            columns={[
              { field: "COUNT", headerName: "Count", flex: 1 },
              { field: "name", headerName: "Name", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.name }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Nightly Vision build jobs for past 24hrs"}
            queryName={"nightly_jobs_red_past_day"}
            queryParams={[{
                name: "repo",
                type: "string",
                value: "vision",
              }]}
            queryCollection="nightlies"
            columns={[
              { field: "COUNT", headerName: "Count", flex: 1 },
              { field: "name", headerName: "Name", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.name }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Nightly Audio build jobs for past 24hrs"}
            queryName={"nightly_jobs_red_past_day"}
            queryParams={[{
                name: "repo",
                type: "string",
                value: "audio",
              }]}
            queryCollection="nightlies"
            columns={[
              { field: "COUNT", headerName: "Count", flex: 1 },
              { field: "name", headerName: "Name", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.name }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Nightly Text build jobs for past 24hrs"}
            queryName={"nightly_jobs_red_past_day"}
            queryParams={[{
                name: "repo",
                type: "string",
                value: "text",
              }]}
            queryCollection="nightlies"
            columns={[
              { field: "COUNT", headerName: "Count", flex: 1 },
              { field: "name", headerName: "Name", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.name }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Failed nightly jobs for PyTorch and Domains for selected time range"}
            queryName={"nightly_jobs_red_by_name"}
            queryParams={timeParams}
            queryCollection="nightlies"
            columns={[
              { field: "COUNT", headerName: "Count", flex: 1 },
              { field: "name", headerName: "Name", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.name }}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TablePanel
            title={"Failed nightly jobs for PyTorch and Domains for selected time range by platform"}
            queryName={"nightly_jobs_red_by_platform"}
            queryParams={timeParams}
            queryCollection="nightlies"
            columns={[
              { field: "Count", headerName: "Count", flex: 1 },
              { field: "Platform", headerName: "Platform", flex: 4 },
            ]}
            dataGridProps={{ getRowId: (el: any) => el.Platform }}
          />
        </Grid>
      </Grid>
    </div>
  );
}
