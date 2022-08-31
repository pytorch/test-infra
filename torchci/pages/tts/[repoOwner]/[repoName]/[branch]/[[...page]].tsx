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
    <ReactECharts
      style={{ height: "100%", width: "100%" }}
      option={options}
      notMerge={true}
    />
  );
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
  granularity: Granularity;
  ttsPercentile: number;
  selectedJobName: string;
  checkboxRef: any;
  branchName: string;
}) {
  const [filter, setFilter] = useState(new Set());
  const ROW_HEIGHT = 800;

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

  const { data, error } = useSWR(url, fetcher, {
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
  let startTime = queryParams.find((p) => p.name === "startTime")?.value;
  let stopTime = queryParams.find((p) => p.name === "stopTime")?.value;

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  startTime = dayjs(startTime).startOf(granularity);
  stopTime = dayjs(stopTime).endOf(granularity);

  const tts_true_series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    ttsFieldName
  );
  const duration_true_series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    durationFieldName
  );
  var tts_series = tts_true_series.filter((item: any) =>
    filter.has(item["name"])
  );
  var duration_series = duration_true_series.filter((item: any) =>
    filter.has(item["name"])
  );

  const encodedBranchName = encodeURIComponent(branchName);
  const jobUrlPrefix = `/tts/pytorch/pytorch/${encodedBranchName}?jobName=`;

  return (
    <Grid container spacing={2}>
      <Grid item xs={9} height={ROW_HEIGHT}>
        <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
          <Panel title={"tts"} series={tts_series} />
        </Paper>
        <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
          <Panel title={"duration"} series={duration_series} />
        </Paper>
      </Grid>
      <Grid item xs={3} height={ROW_HEIGHT}>
        <div
          style={{ overflow: "auto", height: ROW_HEIGHT, fontSize: "15px" }}
          ref={checkboxRef}
        >
          {tts_true_series.map((job) => (
            <div key={job["name"]}>
              <input
                type="checkbox"
                id={job["name"]}
                onChange={toggleFilter}
                checked={filter.has(job["name"])}
              />
              <label htmlFor={job["name"]}>
                <a href={jobUrlPrefix + encodeURIComponent(job["name"])}>
                  {job["name"]}
                </a>
              </label>
            </div>
          ))}
        </div>
      </Grid>
    </Grid>
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
        <MenuItem value={"minute"}>minute (no interpolation)</MenuItem>
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
