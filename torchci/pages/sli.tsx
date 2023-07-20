import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";
import useSWR from "swr";
import { useEffect, useState } from "react";
import {
    Autocomplete,
    Checkbox,
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
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import { RocksetParam } from "lib/rockset";
import { LocalizationProvider, DateTimePicker } from "@mui/x-date-pickers";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import { fetcher } from "lib/GeneralUtils";

const ROW_HEIGHT = 600;

const icon = <CheckBoxOutlineBlankIcon fontSize="small" />;
const checkedIcon = <CheckBoxIcon fontSize="small" />;

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
        <FormControl sx={{ m: 1, minWidth: 80 }} size="small">
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
            <MenuItem value="p50">p50</MenuItem>
            <MenuItem value="p80">p80</MenuItem>
            <MenuItem value="p90">p90</MenuItem>
            <MenuItem value="p95">p95</MenuItem>
            <MenuItem value="p99">p99</MenuItem>
            <MenuItem value="max">max</MenuItem>
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
        <FormControl sx={{ m: 1, minWidth: 140 }} size="small">
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
    workerTypes,
    setWorkerTypes,
    queryParams,
  }: {
    workerTypes: string[];
    setWorkerTypes: any;
    queryParams: RocksetParam[];
  }) {
    const queryName = "get_workers_on_period";
    const queryCollection = "metrics";

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

    function handleChange(event: any, newValue: any) {
        setWorkerTypes(newValue.map((worker: any) => worker.title));
    }

    const labels = data.map((worker: any) => {
        return { title: worker.machine_type, value: worker.machine_type };
    });

    return (
        <>
            <Autocomplete
                multiple
                id="tags-outlined"
                options={labels}
                disableCloseOnSelect
                getOptionLabel={(option) => option.title}
                defaultValue={workerTypes.map((wt: string) => {
                    return { title: wt, value: wt };
                })}
                fullWidth
                size="small"
                onChange={handleChange}
                renderInput={(params) => (
                    <TextField
                        {...params}
                        label="Worker Types"
                        placeholder=""
                    />
                )}
                isOptionEqualToValue={(option, value) => option.title === value.title}
            />
        </>
    );
}

export default function Page() {
    const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
    const [stopTime, setStopTime] = useState(dayjs());
    const [timeRange, setTimeRange] = useState<number>(30);
    const [workerTypes, setWorkerTypes] = useState<string[]>(["all"]);

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
        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
          <Typography fontSize={"2rem"} fontWeight={"bold"} sx={{ mb: 1, minWidth: 280 }}>
            GHA Workers SLI
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
            workerTypes={workerTypes}
            setWorkerTypes={setWorkerTypes}
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
            queryName={"queue_times_historical_pct"}
            queryParams={[
              {
                name: "timezone",
                type: "string",
                value: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
              {
                name: "pctile",
                type: "string",
                value: ttsPercentile,
              },
              {
                name: "workersTypes",
                type: "string",
                value: workerTypes.join(","),
              },
              ...timeParams,
            ]}
            granularity={"hour"}
            groupByFieldName={"machine_type"}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={`queue_s_${ttsPercentile}`}
            yAxisRenderer={durationDisplay}
          />
        </Grid>
      </div>
    )
}
