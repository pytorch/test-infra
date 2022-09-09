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

export type Granularity = "minute" | "hour" | "day" | "week" | "month" | "year";

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

export function seriesWithInterpolatedTimes(
  data: any,
  startTime: dayjs.Dayjs,
  stopTime: dayjs.Dayjs,
  granularity: Granularity,
  groupByFieldName: string | undefined,
  timeFieldName: string,
  yAxisFieldName: string
) {
  // We want to interpolate the data, filling any "holes" in our time series
  // with 0.
  const allTimes: Set<string> = new Set();
  data.forEach((d: any) => allTimes.add(d[timeFieldName]));
  const times: Array<string> = Array.from(allTimes).sort();
  const interpolatedTimes: Array<string> = [];

  let prevT,
    t = startTime;
  for (let i = 0; t.isBefore(stopTime) && i < times.length; i++) {
    prevT = t;
    t = dayjs(times[i]);

    let timeGap = t.diff(prevT, granularity);
    if (timeGap > 1.15) {
      // We're missing too large a chunk of data, so we'll add an interpolated timestamp
      // at the next expected granularity point.
      t = prevT.add(1, granularity);
      i--; // Try processing at the old times[i] again next round, in case there are more gaps to interpolate
    }
    // Normally the time difference is expected to be 1 (or less) of whatever the granularity is.
    // Things like Daylight Savings Time can cause it to increase or decrease a bit.
    // We don't want to interpolate data just because of DST though!
    // For that, we buffer the accpetable granularity a bit
    interpolatedTimes.push(t.toISOString());
  }

  // Group the data by the provided field and generate a time series for each
  // one.
  let byGroup = _.groupBy(data, (d) => "");
  if (groupByFieldName !== undefined) {
    byGroup = _.groupBy(data, (d) => d[groupByFieldName]);
  }

  return _.map(byGroup, (value, key) => {
    const byTime = _.keyBy(value, timeFieldName);
    // Roundtrip each timestamp to make the format uniform.
    const byTimeNormalized = _.mapKeys(byTime, (_, k) =>
      dayjs(k).toISOString()
    );

    // Fill with 0, see the above comment on interpolation.
    const data = interpolatedTimes
      .map((t) => {
        const item = byTimeNormalized[t];
        if (item === undefined && granularity !== "minute") {
          return [t, 0];
        } else if (item === undefined) {
          return undefined;
        } else {
          return [t, item[yAxisFieldName]];
        }
      })
      .filter((t) => t !== undefined);

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
  // What label to put on the y axis.
  yAxisLabel,
  // Additional EChartsOption (ex max y value)
  additionalOptions,
}: {
  title: string;
  queryCollection?: string;
  queryName: string;
  queryParams: RocksetParam[];
  granularity: Granularity;
  groupByFieldName?: string;
  timeFieldName: string;
  yAxisFieldName: string;
  yAxisRenderer: (value: any) => string;
  yAxisLabel?: string;
  additionalOptions?: EChartsOption;
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

  let startTime = queryParams.find((p) => p.name === "startTime")?.value;
  let stopTime = queryParams.find((p) => p.name === "stopTime")?.value;

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  startTime = dayjs(startTime).startOf(granularity);
  stopTime = dayjs(stopTime).endOf(granularity);

  const series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    yAxisFieldName
  );

  // Add extra padding when the legend is active
  const legend_padding = groupByFieldName !== undefined ? 200 : 48;
  const title_padding = yAxisLabel ? 65 : 48;
  const options: EChartsOption = _.merge(
    {
      title: { text: title },
      grid: { top: title_padding, right: legend_padding, bottom: 24, left: 48 },
      dataset: { source: data },
      xAxis: { type: "time" },
      yAxis: {
        name: yAxisLabel,
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
          `<br/>${dayjs(params.value[0])
            .local()
            .format("M/D h:mm:ss A")}<br/>` +
          `${getTooltipMarker(params.color)}` +
          `<b>${yAxisRenderer(params.value[1])}</b>`,
      },
    },
    additionalOptions
  );

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}
