import AdapterDayjs from "@mui/lab/AdapterDayjs";
import LocalizationProvider from "@mui/lab/LocalizationProvider";
import dayjs from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import {
  DataGrid,
  GridRenderCellParams,
  GridValueFormatterParams,
  GridColDef,
} from "@mui/x-data-grid";
import useSWR from "swr";
import {
  Box,
  Grid,
  Paper,
  TextField,
  Typography,
  Stack,
  Skeleton,
} from "@mui/material";
import { DateTimePicker } from "@mui/lab";
import { useState } from "react";

import { RocksetParam } from "lib/rockset";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

// Given a number of seconds, convert it to the biggest possible unit of
// measurement and display with a scale of 1.
// e.g. 5400 -> "1.5h"
function durationDisplay(seconds: number): string {
  if (seconds < 60) {
    return seconds + "s";
  }
  const minutes = seconds / 60.0;
  if (minutes < 60) {
    return minutes.toFixed(1) + "m";
  }
  const hours = minutes / 60.0;
  if (hours < 24) {
    return hours.toFixed(1) + "h";
  }
  const days = hours / 24.0;
  return days.toFixed(1) + "d";
}

function NumberPanel({
  title,
  queryName,
  valueRenderer,
  metricName,
  params,
}: {
  title: string;
  queryName: string;
  valueRenderer: (value: any) => string;
  metricName: string;
  params: RocksetParam[];
}) {
  const url = `/api/metrics/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const value = data[0][metricName];

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Typography sx={{ fontSize: "1rem", fontWeight: "bold" }}>
          {title}
        </Typography>
        <Typography sx={{ fontSize: "4rem", my: "auto", alignSelf: "center" }}>
          {valueRenderer(value)}
        </Typography>
      </Box>
    </Paper>
  );
}

function MasterJobsRedPanel({ params }: { params: RocksetParam[] }) {
  const url = `/api/metrics/master_jobs_red?parameters=${encodeURIComponent(
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
  const url = `/api/metrics/master_commit_red?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const options: EChartsOption = {
    title: { text: "% commits red on master, by day" },
    grid: { top: 48, right: 8, bottom: 24, left: 36 },
    dataset: { source: data },
    xAxis: { type: "category" },
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

function QueuedJobsByLabelPanel() {
  const { data } = useSWR(
    "/api/metrics/queued_jobs_by_label?parameters=[]",
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
    }
  );

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const columns: GridColDef[] = [
    { field: "count", headerName: "Count", flex: 1 },
    {
      field: "avg_queue_s",
      headerName: "Avg queue time",
      flex: 1,
      valueFormatter: (params: GridValueFormatterParams<number>) =>
        durationDisplay(params.value),
    },
    { field: "labels", headerName: "Machine Type", flex: 4 },
  ];
  function Header() {
    return (
      <Typography fontSize="16px" fontWeight="700" sx={{ p: 1 }}>
        Queued Jobs by Machine Type
      </Typography>
    );
  }
  return (
    <DataGrid
      density={"compact"}
      rows={data}
      columns={columns}
      getRowId={(el: any) => el.labels[0]}
      hideFooter
      components={{
        Toolbar: Header,
      }}
    />
  );
}

function TTSPanel({
  params,
  queryName,
  metricHeaderName,
  metricName,
  panelTitle,
}: {
  params: RocksetParam[];
  queryName: string;
  metricHeaderName: string;
  metricName: string;
  panelTitle: string;
}) {
  const url = `/api/metrics/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const columns: GridColDef[] = [
    {
      field: metricName,
      headerName: metricHeaderName,
      flex: 1,
      valueFormatter: (params: GridValueFormatterParams<number>) =>
        durationDisplay(params.value),
    },
    { field: "count", headerName: "Count", flex: 1 },
    { field: "name", headerName: "Name", flex: 5 },
  ];
  function Header() {
    return (
      <Typography fontSize="16px" fontWeight="700" sx={{ p: 1 }}>
        {panelTitle}
      </Typography>
    );
  }
  return (
    <DataGrid
      density={"compact"}
      rows={data}
      columns={columns}
      getRowId={(el: any) => el.name}
      hideFooter
      components={{
        Toolbar: Header,
      }}
    />
  );
}

function QueuedJobsPanel() {
  const { data } = useSWR("/api/metrics/queued_jobs?parameters=[]", fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const columns: GridColDef[] = [
    {
      field: "queue_s",
      headerName: "Time in Queue",
      flex: 1,
      valueFormatter: (params: GridValueFormatterParams<number>) =>
        durationDisplay(params.value),
    },
    { field: "labels", headerName: "Machine Type", flex: 1 },
    {
      field: "name",
      headerName: "Job Name",
      flex: 4,
      renderCell: (params: GridRenderCellParams<string>) => (
        <a href={params.row.html_url}>{params.value}</a>
      ),
    },
    { field: "html_url" },
  ];
  function Header() {
    return (
      <Typography fontSize="16px" fontWeight="700" sx={{ p: 1 }}>
        Jobs in Queue
      </Typography>
    );
  }
  return (
    <DataGrid
      density={"compact"}
      columnVisibilityModel={{
        html_url: false,
      }}
      rows={data}
      columns={columns}
      getRowId={(el: any) => el.html_url}
      hideFooter
      components={{
        Toolbar: Header,
      }}
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

const ROW_HEIGHT = 340;

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());

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

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch CI Metrics
        </Typography>
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
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={6} height={ROW_HEIGHT}>
          <MasterJobsRedPanel params={timeParams} />
        </Grid>
        <Grid item xs={2}>
          <NumberPanel
            title={"% red jobs red on master, aggregate"}
            queryName={"master_jobs_red_avg"}
            metricName={"red"}
            valueRenderer={(value) => (value * 100).toFixed(2) + "%"}
            params={timeParams}
          />
        </Grid>

        <Grid item xs={2}>
          <NumberPanel
            title={"# reverts"}
            queryName={"reverts"}
            metricName={"num"}
            valueRenderer={(value: string) => value}
            params={timeParams}
          />
        </Grid>

        <Grid item xs={2}>
          <NumberPanel
            title={"Last viable/strict push"}
            queryName={"last_branch_push"}
            metricName={"push_seconds_ago"}
            valueRenderer={(value) => durationDisplay(value)}
            params={[
              {
                name: "branch",
                type: "string",
                value: "refs/heads/viable/strict",
              },
            ]}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <MasterCommitRedPanel params={timeParams} />
        </Grid>

        <Grid item xs={2}>
          <NumberPanel
            title={"% commits red on master, aggregate"}
            queryName={"master_commit_red_avg"}
            metricName={"red"}
            valueRenderer={(value) => (value * 100).toFixed(2) + "%"}
            params={timeParams}
          />
        </Grid>

        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <NumberPanel
              title={"Last master push"}
              queryName={"last_branch_push"}
              metricName={"push_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              params={[
                {
                  name: "branch",
                  type: "string",
                  value: "refs/heads/master",
                },
              ]}
            />
            <NumberPanel
              title={"Last nightly push"}
              queryName={"last_branch_push"}
              metricName={"push_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              params={[
                {
                  name: "branch",
                  type: "string",
                  value: "refs/heads/nightly",
                },
              ]}
            />
          </Stack>
        </Grid>

        <Grid container item xs={2} justifyContent={"stretch"}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <NumberPanel
              title={"Last docker build"}
              queryName={"last_successful_workflow"}
              metricName={"last_success_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              params={[
                {
                  name: "workflowName",
                  type: "string",
                  value: "docker-builds",
                },
              ]}
            />
            <NumberPanel
              title={"Last docs push"}
              queryName={"last_successful_jobs"}
              metricName={"last_success_seconds_ago"}
              valueRenderer={(value) => durationDisplay(value)}
              params={[
                {
                  name: "jobNames",
                  type: "string",
                  value:
                    "docs push / build-docs (python),docs push / build-docs (cpp)",
                },
              ]}
            />
          </Stack>
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <QueuedJobsByLabelPanel />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <QueuedJobsPanel />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TTSPanel
            panelTitle={"Job time-to-signal, all branches"}
            queryName={"tts_avg"}
            metricName={"tts_sec"}
            metricHeaderName={"Time-to-signal"}
            params={timeParams}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TTSPanel
            panelTitle={"Job time-to-signal, master-only"}
            queryName={"tts_avg"}
            metricName={"tts_sec"}
            metricHeaderName={"Time-to-signal"}
            params={[
              ...timeParams,
              {
                name: "branch",
                type: "string",
                value: "master",
              },
            ]}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TTSPanel
            panelTitle={"Job duration, all branches"}
            queryName={"job_duration_avg"}
            metricName={"duration_sec"}
            metricHeaderName={"Duration"}
            params={timeParams}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TTSPanel
            panelTitle={"Job duration, master-only"}
            queryName={"job_duration_avg"}
            metricName={"duration_sec"}
            metricHeaderName={"Duration"}
            params={[
              ...timeParams,
              {
                name: "branch",
                type: "string",
                value: "master",
              },
            ]}
          />
        </Grid>
      </Grid>
    </div>
  );
}
