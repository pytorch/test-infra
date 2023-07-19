import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";
import useSWR from "swr";
import { useEffect, useState } from "react";
import {
    Autocomplete,
    FormControl,
    Grid,
    InputLabel,
    MenuItem,
    Select,
    SelectChangeEvent,
    Skeleton,
    Stack,
    TextField,
    Typography,
  } from "@mui/material";
import { RocksetParam } from "lib/rockset";
import { LocalizationProvider, DateTimePicker } from "@mui/x-date-pickers";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import { fetcher } from "lib/GeneralUtils";

const ROW_HEIGHT = 600;

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

export function TtsPercentilePicker({
    ttsPercentile,
    setTtsPercentile,
  }: {
    ttsPercentile: string;
    setTtsPercentile: any;
  }) {
    function handleChange(e: SelectChangeEvent<string>) {
      setTtsPercentile(e.target.value as string);
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
            <MenuItem value="avg">avg</MenuItem>
            <MenuItem value="p25">p25</MenuItem>
            <MenuItem value="p50">p50</MenuItem>
            <MenuItem value="p80">p80</MenuItem>
            <MenuItem value="p90">p90</MenuItem>
            <MenuItem value="p95">p95</MenuItem>
            <MenuItem value="p99">p99</MenuItem>
            <MenuItem value="p99.9">p99.9</MenuItem>
            <MenuItem value="max">p100</MenuItem>
          </Select>
        </FormControl>
      </>
    );
}
  
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

function WorkerTypePicker({
    queryParams,
  }: {
    queryParams: RocksetParam[];
  }) {
    const queryName = "compilers_benchmark_performance_branches";
    const queryCollection = "inductor";

    const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
      JSON.stringify(queryParams)
    )}`;

    let { data, error } = useSWR(url, fetcher, {
      refreshInterval: 20 * 60 * 1000, // refresh 20 minutes
    });

    if (error !== undefined) {
        return (
            <div>
                An error occurred while fetching data, perhaps there are too many
                results with your choice of time range and granularity?
            </div>
        );
    }

    if (data === undefined || data.length === 0) {
        return <Skeleton variant={"rectangular"} height={"100%"} />;
    }

    function handleChange(e: SelectChangeEvent<string>) {
        console.log("selected");
    }

    const labels = [
        { label: "CPU", value: "cpu" },
        { label: "GPU", value: "gpu" },
        { label: "TPU", value: "tpu" },
        { label: "FPGA", value: "fpga" },
        { label: "ASIC", value: "asic" },
        { label: "Other", value: "other" },
    ];

    return (
        <>
            <Autocomplete
                multiple
                id="tags-outlined"
                options={labels}
                getOptionLabel={(option) => option.label}
                defaultValue={[labels[1]]}
                filterSelectedOptions
                renderInput={(params) => (
                    <TextField
                        {...params}
                        label="filterSelectedOptions"
                        placeholder="Favorites"
                    />
                )}
            />
        </>
    );
}

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

    const [ttsPercentile, setTtsPercentile] = useState<string>("p95");

    return (
      <div>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"2rem"} fontWeight={"bold"}>
            PyTorch GHA Worker SLI
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
          <WorkerTypePicker
            queryParams={[
                {
                  name: "timezone",
                  type: "string",
                  value: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
                ...timeParams,
              ]}
          />
        </Stack>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"GHA Worker Queue Time"}
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
      </div>
    )
}
