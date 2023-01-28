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

const SUPPORTED_WORKFLOWS = [
  "lint",
  "pull",
  "trunk",
  "periodic",
  "inductor",
];

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
  selectedJobName,
  checkboxRef,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  selectedJobName: string;
  checkboxRef: any;
}) {
  const [filter, setFilter] = useState(new Set());

  const queryName = "master_commit_red_percent_groups";
  const url = `/api/query/metrics/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many results
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

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(queryParams.find((p) => p.name === "startTime")?.value).startOf(granularity);
  const stopTime = dayjs(queryParams.find((p) => p.name === "stopTime")?.value).startOf(granularity);

  const redFieldName = "red";
  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "name";

  const redPercentages = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    ttsFieldName
  );

  const rowHeight = 800;
  const jobUrlPrefix = `/reliability/pytorch/pytorch?jobName=`;
  return (
    <Grid container spacing={2}>
      <Grid item xs={9} height={rowHeight}>
        <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
          <Panel title={"%"} series={redPercentages} />
        </Paper>
      </Grid>
      <Grid item xs={3} height={rowHeight}>
        <div
          style={{ overflow: "auto", height: rowHeight, fontSize: "15px" }}
          ref={checkboxRef}
        >
          {redPercentages.map((job) => (
            <div key={job["name"]}>
              <input
                type="checkbox"
                id={job[groupByFieldName]}
                onChange={toggleFilter}
                checked={filter.has(job[groupByFieldName])}
              />
              <label htmlFor={job[groupByFieldName]}>
                <a href={jobUrlPrefix + encodeURIComponent(job[groupByFieldName])}>
                  {job[groupByFieldName]}
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
      </Select>
    </FormControl>
  );
}

export default function Page() {
  const router = useRouter();
  const jobName: string = (router.query.jobName as string) ?? "none";

  const [startTime, setStartTime] = useState(dayjs().subtract(1, "month"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
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
      name: "granularity",
      type: "string",
      value: granularity,
    },
    {
      name: "workflowNames",
      type: "string",
      value: SUPPORTED_WORKFLOWS.join(","),
    },
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
          Red signal percentage by jobs
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
      <Graphs
        queryParams={queryParams}
        granularity={granularity}
        selectedJobName={jobName}
        checkboxRef={checkboxRef}
      />
    </div>
  );
}
