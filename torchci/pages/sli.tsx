import {
  Autocomplete,
  FormControl,
  Grid2,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { DateTimePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import CopyLink from "components/CopyLink";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";

const ROW_HEIGHT = 600;

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
          <MenuItem value={60}>Last 2 Months</MenuItem>
          <MenuItem value={90}>Last 3 Months</MenuItem>
          <MenuItem value={180}>Last 6 Months</MenuItem>
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
  queryParams: { [key: string]: any };
}) {
  const queryName = "get_workers_on_period";

  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  let { data, error, isLoading } = useSWR(url, fetcher, {
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

  if (data === undefined || data.length === 0 || isLoading) {
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
          <TextField {...params} label="Worker Types" placeholder="" />
        )}
        isOptionEqualToValue={(option, value) => option.title === value.title}
      />
    </>
  );
}

export default function Page() {
  const router = useRouter();

  const { query } = router;

  const initialStopTime = query.stopTime
    ? dayjs(query.stopTime as string)
    : dayjs();
  const initialTimeRange = query.timeRange
    ? parseInt(query.timeRange as string)
    : 7;
  const initialStartTime = query.startTime
    ? dayjs(query.startTime as string)
    : initialStopTime.subtract(initialTimeRange, "day");
  const initialWorkerTypes = query.workerTypes
    ? (query.workerTypes as string).split(",")
    : ["pet", "ephemeral", "nonephemeral"];
  const initialTtsPercentile = query.ttsPercentile
    ? (query.ttsPercentile as string)
    : "p80";

  const [startTime, setStartTime] = useState(initialStartTime);
  const [stopTime, setStopTime] = useState(initialStopTime);
  const [timeRange, setTimeRange] = useState(initialTimeRange);
  const [workerTypes, setWorkerTypes] = useState(initialWorkerTypes);
  const [ttsPercentile, setTtsPercentile] = useState(initialTtsPercentile);
  const [routerReady, setRouterReady] = useState(false);

  if (!routerReady && router.isReady) {
    setRouterReady(true);
    setStartTime(initialStartTime);
    setStopTime(initialStopTime);
    setTimeRange(initialTimeRange);
    setWorkerTypes(initialWorkerTypes);
    setTtsPercentile(initialTtsPercentile);
  }

  const fullUrl = routerReady
    ? `${window.location.origin}${router.asPath}`
    : "";

  useEffect(() => {
    if (!router.isReady) return;

    const params = new URLSearchParams();

    if (timeRange !== -1) {
      params.set("timeRange", timeRange.toString());
    } else if (startTime && stopTime) {
      params.set("startTime", startTime.utc().format("YYYY-MM-DD"));
      params.set("stopTime", stopTime.utc().format("YYYY-MM-DD"));
    } else {
      params.set("timeRange", "7");
    }

    if (workerTypes) {
      params.set("workerTypes", workerTypes.join(","));
    } else {
      params.set("workerTypes", initialWorkerTypes.join(","));
    }
    if (ttsPercentile) {
      params.set("ttsPercentile", ttsPercentile);
    } else {
      params.set("ttsPercentile", initialTtsPercentile);
    }

    router.push({
      pathname: router.pathname,
      query: params.toString(),
    });
  }, [
    initialTtsPercentile,
    initialWorkerTypes,
    router,
    startTime,
    stopTime,
    timeRange,
    ttsPercentile,
    workerTypes,
  ]);

  return (
    <div>
      {routerReady && (
        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
          <Typography
            fontSize={"2rem"}
            fontWeight={"bold"}
            sx={{ mb: 1, minWidth: 280 }}
          >
            GHA Workers SLI
          </Typography>
          <CopyLink
            textToCopy={fullUrl}
            link={true}
            compressed={false}
            style={{
              fontSize: "1rem",
              borderRadius: 10,
            }}
          />
        </Stack>
      )}
      {routerReady && (
        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
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
            queryParams={{
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
              stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
            }}
          />
        </Stack>
      )}
      {routerReady && (
        <Grid2 size={{ xs: 6 }} height={ROW_HEIGHT}>
          <TimeSeriesPanel
            title={"GHA Worker Queue Time"}
            queryName={"queue_times_historical_pct"}
            queryParams={{
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              pctile: ttsPercentile,
              workersTypes: workerTypes,
              startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
              stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
            }}
            granularity={"hour"}
            groupByFieldName={"machine_type"}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={`queue_s_${ttsPercentile}`}
            yAxisRenderer={durationDisplay}
          />
        </Grid2>
      )}
    </div>
  );
}
