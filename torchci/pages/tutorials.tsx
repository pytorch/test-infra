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
import ScalarPanel from "components/metrics/panels/ScalarPanel";
import TablePanel from "components/metrics/panels/TablePanel";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";

// Specialized version of TablePanel for TTS metrics.
function TTSPanel({
  title,
  queryName,
  queryParams,
  metricHeaderName,
  metricName,
  branchName
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
              <a href={`/tts/pytorch/pytorch/${encodedBranchName}?jobName=${encodedJobName}`}>
                {jobName}
              </a>
            );
          }
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
  stopTime,
  setStartTime,
  setStopTime,
}: {
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  setStartTime: any;
  setStopTime: any;
}) {
  // User-selected time range. If it's a number, the range is (#days to now). If
  // it's -1, the time range has been to a custom value.
  const [timeRange, setTimeRange] = useState<number>(7);

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
          defaultValue={7}
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
          <MenuItem value={-1}>Custom Time Range</MenuItem>
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
        <InputLabel id="tts-percentile-picker-select-label">Percentile</InputLabel>
        <Select
          defaultValue={ttsPercentile}
          label="Percentile"
          labelId="tts-percentile-picker-select-label"
          onChange={handleChange}
        >
          <MenuItem value={-1.0}>avg</MenuItem>
          <MenuItem value={0.50}>p50</MenuItem>
          <MenuItem value={0.90}>p90</MenuItem>
          <MenuItem value={0.95}>p95</MenuItem>
          <MenuItem value={0.99}>p99</MenuItem>
          <MenuItem value={1.00}>p100</MenuItem>
        </Select>
      </FormControl>
    </>
  );
}

function WorkflowDuration({
  percentileParam,
  timeParams,
  workflowName,
}: {
  percentileParam: RocksetParam;
  timeParams: RocksetParam[];
  workflowName: string;
}) {
  const ttsPercentile = percentileParam.value;

  let title: string = `p${ttsPercentile * 100} ${workflowName} workflow duration`;
  let queryName: string = "workflow_duration_percentile";

  // -1 is the specical case where we will show the avg instead
  if (ttsPercentile === -1) {
    title = `avg ${workflowName} workflow duration`;
    queryName = queryName.replace("percentile", "avg");
  }

  return (
    <ScalarPanel
      title={title}
      queryName={queryName}
      metricName={"duration_sec"}
      valueRenderer={(value) => durationDisplay(value)}
      queryParams={[
        { name: "name", type: "string", value: workflowName },
        percentileParam,
        ...timeParams,
      ]}
      badThreshold={(value) => value > 60 * 60 * 3} // 3 hours
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

  const [ttsPercentile, setTtsPercentile] = useState<number>(0.50);



  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch Tutorials Metrics
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
        />
        <TtsPercentilePicker
          ttsPercentile={ttsPercentile}
          setTtsPercentile={setTtsPercentile}
        />
      </Stack>
      <Grid item xs={6} height={ROW_HEIGHT}>
        <TablePanel
          title={"Last Updated Tutorials"}
          queryCollection={"tutorials"}
          queryName={"last_updated_tutorials"}
          queryParams={[]}
          columns={[
            { field: "filename", headerName: "Filename", flex: 4 },
            { field: "last_updated", headerName: "Last Updated", flex: 1 },
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
    </div >
  );
}
