/**
 * A metrics panel that shows a time series line chart.
 */

import { RocksetParam } from "lib/rockset";
import ReactECharts from "echarts-for-react";
import { Paper, Skeleton } from "@mui/material";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";
import { EChartsOption } from "echarts";
import _ from "lodash";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

// Adapted from echarts
// see: https://github.com/apache/echarts/blob/master/src/util/format.ts
export function getTooltipMarker(color: string) {
  return (
    '<span style="display:inline-block;margin-right:4px;' +
    "border-radius:10px;width:10px;height:10px;background-color:" +
    color +
    ";" +
    '"></span>'
  );
}

export function normalSeries(
  data: any,
  timeFieldName: string,
  yAxisFieldName: string,
  name: string
) {
  const allTimes: Set<string> = new Set();
  const times: Array<string> = Array.from(allTimes).sort();
  console.log(data);
  const normalizedData = data.map((point: any) => {
    return [point[timeFieldName], point[yAxisFieldName]];
  });
  return {
    name: name,
    type: "line",
    symbol: "circle",
    symbolSize: 4,
    data: normalizedData,
    emphasis: {
      focus: "series",
    },
  };
}

export function seriesWithInterpolatedTimes(
  data: any,
  granularity: any,
  groupByFieldName: string,
  timeFieldName: string,
  yAxisFieldName: string
) {
  // We want to interpolate the data, filling any "holes" in our time series
  // with 0.
  console.log(data);
  const allTimes: Set<string> = new Set();
  data.forEach((d: any) => allTimes.add(dayjs(d[timeFieldName]).toISOString()));
  const times: Array<string> = Array.from(allTimes).sort();
  const startTime = dayjs(times[0]);
  const endTime = dayjs(times.at(-1));
  const interpolatedTimes: Array<string> = [];
  for (let t = startTime; t.isBefore(endTime); t = t.add(1, granularity)) {
    interpolatedTimes.push(t.toISOString());
  }

  // Group the data by the provided field and generate a time series for each
  // one.
  let byGroup = _.groupBy(data, (d) => "");
  if (groupByFieldName !== undefined) {
    byGroup = _.groupBy(data, (d) => d[groupByFieldName]);
  }

  const temp = _.map(byGroup, (value, key) => {
    const byTime = _.keyBy(value, timeFieldName);
    // Roundtrip each timestamp to make the format uniform.
    const byTimeNormalized = _.mapKeys(byTime, (_, k) =>
      dayjs(k).toISOString()
    );

    // Fill with 0, see the above comment on interpolation.
    const data = times.map((t) => {
      const item = byTimeNormalized[t];
      if (item === undefined) {
        return [t, 0];
      } else {
        return [t, item[yAxisFieldName]];
      }
    });
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
  console.log("TEMP iS", temp);
  return temp;
}

export default function TimeSeriesPanel({
  // Human-readable title of the panel.
  title,
  // Query lambda collection in Rockset.
  queryCollection = "metrics",
  // Query lambda name in Rockset.
  queryName,
  // Rockset query parameters
  queryParams,
  // Granularity of the time buckets.
  granularity,
  // What field name to group by. Each unique value in this field will show up
  // as its own line.
  groupByFieldName,
  // What field name to treat as the time value.
  timeFieldName,
  // What field name to put on the y axis.
  yAxisFieldName,
  // Callback to render the y axis value in some nice way.
  yAxisRenderer,
  // Interpolate Data or Render as is
  interpolateData = true,
}: {
  title: string;
  queryCollection?: string;
  queryName: string;
  queryParams: RocksetParam[];
  granularity: "hour" | "day" | "week" | "month" | "year";
  groupByFieldName: string;
  timeFieldName: string;
  yAxisFieldName: string;
  yAxisRenderer: (value: any) => string;
  interpolateData?: boolean;
}) {
  // - Granularity
  // - Group by
  // - Time field
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify([
      ...queryParams,
      { name: "granularity", type: "string", value: granularity },
    ])
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  let series: any;
  if (interpolateData) {
    series = seriesWithInterpolatedTimes(
      data,
      granularity,
      groupByFieldName,
      timeFieldName,
      yAxisFieldName
    );
  } else {
    series = normalSeries(data, timeFieldName, yAxisFieldName, title);
  }
  const options: EChartsOption = {
    title: { text: title },
    grid: { top: 48, right: 200, bottom: 24, left: 48 },
    dataset: { source: data },
    xAxis: { type: "time" },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: yAxisRenderer,
      },
    },
    // @ts-ignore
    series,
    legend: {
      orient: "vertical",
      right: 10,
      top: "center",
      type: "scroll",
    },
    // @ts-ignore
    tooltip: {
      trigger: "item",
      formatter: (params: any) =>
        `${params.seriesName}` +
        `<br/>${dayjs(params.value[0]).local().format("M/D h:mm:ss A")}<br/>` +
        `${getTooltipMarker(params.color)}` +
        `<b>${yAxisRenderer(params.value[1])}</b>`,
    },
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}
