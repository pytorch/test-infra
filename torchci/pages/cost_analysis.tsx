import {
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { DateTimePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import TimeSeriesPanel, {
  Granularity,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { useEffect, useState } from "react";

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

const costDisplay = (value: number) => {
  if (value < 1000) {
    return `$${value.toFixed(2)}`;
  }
  if (value < 10000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return `$${(value / 1000).toFixed(0)}k`;
};
// make an hour display function that shows int hours for everything < 1000 or 2.3k hours for everything > 1000
const hourDisplay = (value: number) => {
  if (value < 1000) {
    return `${value.toFixed(0)}h`;
  }
  if (value < 10000) {
    return `${(value / 1000).toFixed(1)}k h`;
  }
  return `${(value / 1000).toFixed(0)}k h`;
};

const ROW_HEIGHT = 375;

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);
  const [granularity, setGranularity] = useState("day" as Granularity);

  const timeParamsClickHouse = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const generateTimeSeriesGridItem = (
    groupby:
      | "runner_type"
      | "workflow_name"
      | "job_name"
      | "platform"
      | "provider",
    yAxis: "cost" | "duration"
  ) => {
    return (
      <Grid item xs={6} height={ROW_HEIGHT}>
        <TimeSeriesPanel
          title={`CI ${yAxis} per ${groupby} per ${granularity}`}
          queryName={`${yAxis}_job_per_${groupby}`}
          queryParams={{ ...timeParamsClickHouse, groupby }}
          granularity={granularity}
          groupByFieldName={groupby}
          timeFieldName={"granularity_bucket"}
          yAxisFieldName={`total_${yAxis}`}
          yAxisRenderer={yAxis === "cost" ? costDisplay : hourDisplay}
          useClickHouse={true}
        />
      </Grid>
    );
  };

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
        <FormControl>
          <InputLabel id="granularity-select-label">Granularity</InputLabel>
          <Select
            value={granularity}
            label="Granularity"
            labelId="granularity-select-label"
            onChange={(e) => setGranularity(e.target.value as Granularity)}
          >
            <MenuItem value={"day"}>Daily</MenuItem>
            <MenuItem value={"week"}>Weekly</MenuItem>
            <MenuItem value={"month"}>Monthly</MenuItem>
          </Select>
        </FormControl>
      </Stack>

      <Grid container spacing={2}>
        {generateTimeSeriesGridItem("workflow_name", "cost")}
        {generateTimeSeriesGridItem("workflow_name", "duration")}
        {generateTimeSeriesGridItem("job_name", "cost")}
        {generateTimeSeriesGridItem("job_name", "duration")}
        {generateTimeSeriesGridItem("runner_type", "cost")}
        {generateTimeSeriesGridItem("runner_type", "duration")}
        {generateTimeSeriesGridItem("platform", "cost")}
        {generateTimeSeriesGridItem("platform", "duration")}
        {generateTimeSeriesGridItem("provider", "cost")}
        {generateTimeSeriesGridItem("provider", "duration")}
      </Grid>
    </div>
  );
}
