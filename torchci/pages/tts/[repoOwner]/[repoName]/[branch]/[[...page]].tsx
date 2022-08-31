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
import { useRouter } from "next/router";
import { useCallback, useRef, useState } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  Granularity,
  getTooltipMarker,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import React from "react";
import { TimeRangePicker, TtsPercentilePicker } from "../../../../metrics";

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
    <Paper sx={{ p: 2, height: "33%" }} elevation={3}>
      <ReactECharts
        style={{ height: "100%", width: "100%" }}
        option={options}
        notMerge={true}
      />
    </Paper>
  );
}

function getSeries(
  data: any,
  startTime: dayjs.Dayjs,
  stopTime: dayjs.Dayjs,
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
      startTime,
      stopTime,
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
  ttsPercentile,
  selectedJobName,
  checkboxRef,
  branchName,
}: {
  queryParams: RocksetParam[];
  granularity: "hour" | "day" | "week" | "month" | "year";
  ttsPercentile: number;
  selectedJobName: string;
  checkboxRef: any;
  branchName: string;
}) {
  const [filter, setFilter] = useState<string[]>([]);
  const ROW_HEIGHT = 1000;

  let queryName = "tts_duration_historical_percentile";
  let ttsFieldName = "tts_percentile_sec";
  let durationFieldName = "duration_percentile_sec";

  // -1 is the special case in which we will use avg instead
  if (ttsPercentile === -1) {
    queryName = "tts_duration_historical";
    ttsFieldName = "tts_avg_sec";
    durationFieldName = "duration_avg_sec";
  }

  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "full_name";
  const url = `/api/query/metrics/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const aggregate_test_time_url = `/api/query/testing/test?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  const { data: aggregate_test_time_data, error: aggregate_test_time_error } =
    useSWR(aggregate_test_time_url, fetcher, {
      refreshInterval: 60 * 60 * 1000, // refresh every hour
    });

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

  let startTime = queryParams.find((p) => p.name === "startTime")?.value;
  let stopTime = queryParams.find((p) => p.name === "stopTime")?.value;

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  startTime = dayjs(startTime).startOf(granularity);
  stopTime = dayjs(stopTime).endOf(granularity);

  const tts_true_series = getSeries(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    ttsFieldName
  );
  const duration_true_series = getSeries(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    durationFieldName
  );
  const agg_test_time_true_series = getSeries(
    aggregate_test_time_data,
    startTime,
    stopTime,
    "minute", // don't interpolate, also this is at the commit granularity
    groupByFieldName,
    "created_at_time",
    "duration_sum_sec"
  );

  var all_job_names = _.map(
    _.unionBy(
      tts_true_series,
      duration_true_series,
      agg_test_time_true_series,
      (item) => item["name"]
    ),
    (item) => item["name"]
  ).sort();

  function toggleFilter(e: any) {
    var jobName = e.target.id;
    if (e.target.checked) {
      setFilter([...filter, jobName]);
    } else if (filter.includes(jobName)) {
      const next = [...filter];
      next.splice(next.indexOf(jobName), 1);
      setFilter(next);
    }
  }

  var tts_series = tts_true_series.filter((item: any) =>
    filter.includes(item["name"])
  );
  var duration_series = duration_true_series.filter((item: any) =>
    filter.includes(item["name"])
  );
  var agg_test_time_series = agg_test_time_true_series.filter((item: any) =>
    filter.includes(item["name"])
  );

  const encodedBranchName = encodeURIComponent(branchName);
  const jobUrlPrefix = `/tts/pytorch/pytorch/${encodedBranchName}?jobName=`;

  const checkboxStyle = { overflow: "auto", height: "100%", fontSize: "15px" };
  return (
    <>
      <Grid container spacing={2}>
        <Grid container item xs={9}>
          <Stack justifyContent={"space-between"} flexGrow={1}>
            <Panel title={"tts"} series={tts_series} />
            <Panel title={"duration"} series={duration_series} />
            <Panel
              title={"total test time (commit granularity)"}
              series={agg_test_time_series}
            />
          </Stack>
        </Grid>
        <Grid item xs={3} height={ROW_HEIGHT}>
          <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
            <div style={checkboxStyle} ref={checkboxRef}>
              {all_job_names.map((name) => (
                <div key={name}>
                  <input
                    type="checkbox"
                    id={name}
                    onChange={toggleFilter}
                    checked={filter.includes(name)}
                  />
                  <label htmlFor={name}>
                    <a href={jobUrlPrefix + encodeURIComponent(name)}>{name}</a>
                  </label>
                </div>
              ))}
            </div>
          </Paper>
        </Grid>
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
  const router = useRouter();
  const branch: string = (router.query.branch as string) ?? "master";
  const jobName: string = (router.query.jobName as string) ?? "none";
  const percentile: number =
    router.query.percentile === undefined
      ? 0.5
      : parseFloat(router.query.percentile as string);

  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [ttsPercentile, setTtsPercentile] = useState<number>(percentile);

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    { name: "startTime", type: "string", value: startTime },
    { name: "stopTime", type: "string", value: stopTime },
    { name: "granularity", type: "string", value: granularity },
    { name: "percentile", type: "float", value: ttsPercentile },
    { name: "branch", type: "string", value: branch },
  ];

  const checkboxRef = useCallback(() => {
    const selectedJob = document.getElementById(jobName);
    if (selectedJob != undefined) {
      selectedJob.click();
    }
  }, [jobName]);

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
        <TtsPercentilePicker
          ttsPercentile={ttsPercentile}
          setTtsPercentile={setTtsPercentile}
        />
      </Stack>
      <Graphs
        queryParams={queryParams}
        granularity={granularity}
        ttsPercentile={ttsPercentile}
        selectedJobName={jobName}
        checkboxRef={checkboxRef}
        branchName={branch}
      />
    </div>
  );
}
