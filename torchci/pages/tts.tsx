import dayjs from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import { Grid, Paper, Skeleton } from "@mui/material";
import { useState } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  getTooltipMarker,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import React from "react";

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

export default function Page() {
  const ROW_HEIGHT = 800;
  const granularity = "day";

  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "full_name";
  const [filter, setFilter] = useState(new Set());
  const [startTime, setStartTime] = useState(dayjs().subtract(6, "month"));
  const [stopTime, setStopTime] = useState(dayjs());

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

  const url = `/api/query/metrics/tts_duration_historical?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

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

  const tts_true_series = seriesWithInterpolatedTimes(
    data,
    granularity,
    groupByFieldName,
    timeFieldName,
    "tts_avg_sec"
  );
  const duration_true_series = seriesWithInterpolatedTimes(
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
    <div>
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
          >
            {tts_true_series.map((job) => (
              <div key={job["name"]}>
                <input
                  type="checkbox"
                  id={job["name"]}
                  onChange={toggleFilter}
                />
                <label htmlFor={job["name"]}> {job["name"]}</label>
              </div>
            ))}
          </div>
        </Grid>
      </Grid>
    </div>
  );
}
