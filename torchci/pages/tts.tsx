import dayjs from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import {
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  getTooltipMarker,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import React from "react";
import { TimeRangePicker } from "./metrics";

function Panel({
  series,
  title,
}: {
  series: Array<any>;
  title: string;
}): JSX.Element {
  const options: EChartsOption = {
    title: { text: title },
    grid: { top: 48, right: 200, bottom: 24, left: 48 },
    xAxis: { type: "time" },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: durationDisplay,
      },
    },
    series,
    legend: {
      orient: "vertical",
      right: 10,
      top: "center",
      type: "scroll",
      textStyle: {
        overflow: "breakAll",
        width: "150",
      },
    },
    tooltip: {
      trigger: "item",
      formatter: (params: any) =>
        `${params.seriesName}` +
        `<br/>${dayjs(params.value[0]).local().format("M/D h:mm:ss A")}<br/>` +
        `${getTooltipMarker(params.color)}` +
        `<b>${durationDisplay(params.value[1])}</b>`,
    },
  };

  return (
    <ReactECharts
      style={{ height: "100%", width: "100%" }}
      option={options}
      notMerge={true}
    />
  );
}

function getSeries(
  data: any,
  granularity: any,
  groupByFieldName: string,
  timeFieldName: string,
  yAxisFieldName: string
) {
  if (granularity == "minute") {
    // dont interpolate, this is kinda like equivalent of granularity commit
    let byGroup = _.groupBy(data, (d) => d[groupByFieldName]);
    return _.map(byGroup, (value, key) => {
      const data = value
        .map((t: any) => {
          return [t[timeFieldName], t[yAxisFieldName]];
        })
        .sort();
      return {
        name: key,
        type: "line",
        symbol: "circle",
        symbolSize: 4,
        data,
        emphasis: {
          focus: "series",
        },
      };
    });
  } else {
    return seriesWithInterpolatedTimes(
      data,
      granularity,
      groupByFieldName,
      timeFieldName,
      yAxisFieldName
    );
  }
}

function Graphs({
  queryParams,
  granularity,
}: {
  queryParams: RocksetParam[];
  granularity: string;
}) {
  const [filter, setFilter] = useState(new Set());
  const ROW_HEIGHT = 800;

  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "full_name";
  const url = `/api/query/metrics/tts_duration_historical?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWR(url, fetcher);

  if (error !== undefined) {
    // TODO: figure out how to deterine what error it actually is, can't just log the error
    // because its in html format instead of json?
    return (
      <div>
        error occured while fetching data, perhaps there are too many results
        with your choice of time range and granularity?
      </div>
    );
  }

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  function toggleFilter(e: any) {
    var jobName = e.target.id;
    const next = new Set(filter);
    if (filter.has(jobName)) {
      next.delete(jobName);
    } else {
      next.add(jobName);
    }
    setFilter(next);
  }

  const tts_true_series = getSeries(
    data,
    granularity,
    groupByFieldName,
    timeFieldName,
    "tts_avg_sec"
  );
  const duration_true_series = getSeries(
    data,
    granularity,
    groupByFieldName,
    timeFieldName,
    "duration_avg_sec"
  );
  var tts_series = tts_true_series.filter((item: any) =>
    filter.has(item["name"])
  );
  var duration_series = duration_true_series.filter((item: any) =>
    filter.has(item["name"])
  );
  return (
    <>
      <Grid item xs={9} height={ROW_HEIGHT}>
        <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
          <Panel title={"tts"} series={tts_series} />
        </Paper>
        <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
          <Panel title={"duration"} series={duration_series} />
        </Paper>
      </Grid>
      <Grid item xs={3} height={ROW_HEIGHT}>
        <div style={{ overflow: "auto", height: ROW_HEIGHT, fontSize: "15px" }}>
          {tts_true_series.map((job) => (
            <div key={job["name"]}>
              <input
                type="checkbox"
                id={job["name"]}
                onChange={toggleFilter}
                checked={filter.has(job["name"])}
              />
              <label htmlFor={job["name"]}> {job["name"]}</label>
            </div>
          ))}
        </div>
      </Grid>
    </>
  );
}

function TotalTestTime({ queryParams }: { queryParams: RocksetParam[] }) {
  const [filter, setFilter] = useState(new Set());
  const ROW_HEIGHT = 800;

  const timeFieldName = "created_at_time";
  const groupByFieldName = "full_name";
  const url = `/api/query/testing/test?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  function toggleFilter(e: any) {
    var jobName = e.target.id;
    const next = new Set(filter);
    if (filter.has(jobName)) {
      next.delete(jobName);
    } else {
      next.add(jobName);
    }
    setFilter(next);
  }
  function toggleAll(e: any) {
    var on = e.target.id;
    const next = new Set(filter);
    if (on == "on") {
      test_time_true_series.forEach((job: any) => next.add(job["name"]));
    } else {
      test_time_true_series.forEach((job: any) => next.delete(job["name"]));
    }
    setFilter(next);
  }

  const { data, error } = useSWR(url, fetcher);

  if (error !== undefined) {
    // TODO: figure out how to deterine what error it actually is, can't just log the error
    // because its in html format instead of json?
    console.log(error);
    return (
      <div>
        error occured while fetching data, perhaps there are too many results
        with your choice of time range?
      </div>
    );
  }

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const test_time_true_series = getSeries(
    data,
    "minute",
    groupByFieldName,
    timeFieldName,
    "duration_sum_sec"
  );
  var test_time_series = test_time_true_series.filter((item: any) =>
    filter.has(item["name"])
  );
  return (
    <>
      <Grid item xs={9} height={ROW_HEIGHT}>
        <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
          <Panel title={"total test time"} series={test_time_series} />
        </Paper>
      </Grid>
      <Grid item xs={3} height={ROW_HEIGHT}>
        <div style={{ overflow: "auto", height: ROW_HEIGHT, fontSize: "15px" }}>
          {test_time_true_series.map((job) => (
            <div key={job["name"]}>
              <input
                type="checkbox"
                id={job["name"]}
                onChange={toggleFilter}
                checked={filter.has(job["name"])}
              />
              <label htmlFor={job["name"]}> {job["name"]}</label>
            </div>
          ))}
          <button onClick={toggleAll} id="on">
            Check ALl
          </button>
          <button onClick={toggleAll} id="off">
            unCheck ALl
          </button>
        </div>
      </Grid>
    </>
  );
}

function GranularityPicker({
  granularity,
  setGranularity,
}: {
  granularity: string;
  setGranularity: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setGranularity(e.target.value);
  }
  return (
    <FormControl>
      <InputLabel id="granularity-select-label">Granularity</InputLabel>
      <Select
        value={granularity}
        label="Granularity"
        labelId="granularity-select-label"
        onChange={handleChange}
      >
        <MenuItem value={"month"}>month</MenuItem>
        <MenuItem value={"week"}>week</MenuItem>
        <MenuItem value={"day"}>day</MenuItem>
        <MenuItem value={"hour"}>hour</MenuItem>
        <MenuItem value={"minute"}>minute</MenuItem>
      </Select>
    </FormControl>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState("day");

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    { name: "startTime", type: "string", value: startTime },
    { name: "stopTime", type: "string", value: stopTime },
    { name: "granularity", type: "string", value: granularity },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Job TTS and Duration
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
      </Stack>
      <Grid container spacing={2}>
        <Graphs queryParams={queryParams} granularity={granularity} />
        <TotalTestTime queryParams={queryParams} />
      </Grid>
    </div>
  );
}
