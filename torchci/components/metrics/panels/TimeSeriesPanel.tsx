/**
 * A metrics panel that shows a time series line chart.
 */

import { Paper, Skeleton } from "@mui/material";
import { formatTimeForCharts, TIME_DISPLAY_FORMAT } from "components/TimeUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { fetcher } from "lib/GeneralUtils";
import _ from "lodash";
import useSWR from "swr";
dayjs.extend(utc);

export type Granularity = "minute" | "hour" | "day" | "week" | "month" | "year";
export type ChartType = "line" | "stacked_bar" | "bar";
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
  yAxisFieldName: string,
  fillMissingData: boolean = true,
  smooth: boolean = true,
  sort_by: "total" | "name" = "name",
  graph_type: ChartType = "line",
  filter: string | undefined = undefined,
  isRegex: boolean = false
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
    t = dayjs.utc(times[i]);

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
  let byGroup = _.groupBy(data, (_d) => "");
  if (groupByFieldName !== undefined) {
    byGroup = _.groupBy(data, (d) => d[groupByFieldName]);
  }

  var series = _.map(byGroup, (value, key) => {
    const byTime = _.keyBy(value, timeFieldName);
    // Roundtrip each timestamp to make the format uniform.
    const byTimeNormalized = _.mapKeys(byTime, (_, k) =>
      dayjs.utc(k).toISOString()
    );

    // Fill with 0, see the above comment on interpolation.
    const data = interpolatedTimes
      .map((t) => {
        const item = byTimeNormalized[t];
        if (item === undefined && granularity !== "minute") {
          return fillMissingData ? [t, 0] : undefined;
        } else if (item === undefined) {
          return undefined;
        } else {
          return [t, item[yAxisFieldName]];
        }
      })
      .filter((t) => t !== undefined);

    var serie = {
      name: key,
      type: graph_type === "line" ? "line" : "bar",

      stack: "",
      symbol: "circle",
      symbolSize: 4,
      data,
      emphasis: {
        focus: "series",
      },
      smooth: smooth,
    };
    if (graph_type === "stacked_bar") {
      serie = {
        ...serie,
        stack: "Total",
      };
    }
    return serie;
  });
  if (filter) {
    if (isRegex) {
      try {
        const regex = new RegExp(filter, "i");
        series = series.filter((s) => regex.test(s.name));
      } catch (e) {
        // If regex is invalid, fall back to simple include
        series = series.filter((s) =>
          s.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
        );
      }
    } else {
      series = series.filter((s) =>
        s.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
      );
    }
  }
  if (sort_by === "name") {
    return _.sortBy(series, (x) => x.name);
  }

  // wewant to sort by total values per group over the entire time range
  // 1. calculate total values per group
  var totalValues = _.mapValues(byGroup, (value) => {
    return _.sumBy(value, (x) => x[yAxisFieldName]);
  });
  // 2. sort by total values
  var sortedSeries = _.sortBy(series, (x) => {
    return -totalValues[x.name];
  });
  return sortedSeries;
}

function sumOfValuesForTimestamp(series: any, timestamp: string) {
  return _.sumBy(series, (x: any) => {
    const item = x.data.find((d: any) => d[0] === timestamp);
    return item ? item[1] : 0;
  });
}

export function TimeSeriesPanelWithData({
  // The time series data to be displayed
  data,
  // Define how the data is presented https://echarts.apache.org/en/option.html#series-line
  series,
  // Human-readable title of the panel.
  title,
  // What field name to group by. Each unique value in this field will show up
  // as its own line.
  groupByFieldName,
  // Display format for the time field (ex "M/D h:mm:ss A")
  timeFieldDisplayFormat = TIME_DISPLAY_FORMAT,
  // Callback to render the y axis value in some nice way.
  yAxisRenderer,
  // What label to put on the y axis.
  yAxisLabel,
  // Additional EChartsOption (ex max y value)
  additionalOptions,
  // To avoid overlapping long legends and the chart
  legendPadding = 200,
  onEvents,
}: {
  data: any;
  series: any;
  title: string;
  groupByFieldName?: string;
  timeFieldDisplayFormat?: string;
  yAxisRenderer: (_value: any) => string;
  yAxisLabel?: string;
  additionalOptions?: EChartsOption;
  legendPadding?: number;
  onEvents?: { [key: string]: any };
}) {
  // Use the dark mode context to determine whether to use the dark theme
  const { darkMode } = useDarkMode();
  // Add extra padding when the legend is active
  const legend_padding = groupByFieldName !== undefined ? legendPadding : 48;
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
        formatter: (name: string) => {
          return name.length > 40 ? name.substring(0, 40) + "..." : name;
        },
        tooltip: {
          show: true,
          formatter: (params: any) => {
            return `<span style="font-size: 12px;">${params.name}</span>`;
          },
        },

        ...(groupByFieldName !== undefined && {
          selector: [
            {
              type: "all",
              title: "All",
            },
            {
              type: "inverse",
              title: "Inv",
            },
          ],
        }),
      },
      // @ts-ignore
      tooltip: {
        trigger: "item",
        formatter: (params: any) =>
          `${params.seriesName}` +
          `<br/>${formatTimeForCharts(
            params.value[0],
            timeFieldDisplayFormat
          )}<br/>` +
          `${getTooltipMarker(params.color)}` +
          `<b>${yAxisRenderer(params.value[1])}</b>` +
          // add total value to tooltip,
          // only for stacked charts
          (series && series[0] && series[0].stack === "Total"
            ? ` (Total: ${yAxisRenderer(
                sumOfValuesForTimestamp(series, params.value[0])
              )})`
            : ""),
      },
    },
    additionalOptions
  );

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        style={{ height: "100%", width: "100%" }}
        theme={darkMode ? "dark-hud" : undefined}
        option={options}
        notMerge={true}
        onEvents={onEvents}
      />
    </Paper>
  );
}

export default function TimeSeriesPanel({
  // Human-readable title of the panel.
  title,
  // Query name
  queryName,
  // Query parameters
  queryParams,
  // Granularity of the time buckets.
  granularity,
  // What field name to group by. Each unique value in this field will show up
  // as its own line.
  groupByFieldName,
  // What field name to treat as the time value.
  timeFieldName,
  // Display format for the time field (ex "M/D h:mm:ss A")
  timeFieldDisplayFormat = TIME_DISPLAY_FORMAT,
  // What field name to put on the y axis.
  yAxisFieldName,
  // Callback to render the y axis value in some nice way.
  yAxisRenderer,
  // What label to put on the y axis.
  yAxisLabel,
  // Additional EChartsOption (ex max y value)
  additionalOptions,
  smooth = true,
  chartType = "line",
  sort_by = "name",
  max_items_in_series = 0,
  filter = undefined,
  isRegex = false,
  auto_refresh = true,
  // Additional function to process the data after querying
  dataReader = undefined,
}: {
  title: string;
  queryName: string;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  groupByFieldName?: string;
  timeFieldName: string;
  timeFieldDisplayFormat?: string;
  yAxisFieldName: string;
  yAxisRenderer: (_value: any) => string;
  yAxisLabel?: string;
  additionalOptions?: EChartsOption;
  smooth?: boolean;
  chartType?: ChartType;
  sort_by?: "total" | "name";
  max_items_in_series?: number;
  filter?: string;
  isRegex?: boolean;
  auto_refresh?: boolean;
  dataReader?: (_data: { [k: string]: any }[]) => { [k: string]: any }[];
}) {
  // - Granularity
  // - Group by
  // - Time field
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify({
      ...queryParams,
      granularity: granularity as string,
    })
  )}`;

  const { data: rawData } = useSWR(url, fetcher, {
    refreshInterval: auto_refresh ? 5 * 60 * 1000 : 0,
  });

  if (rawData === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }
  const data = dataReader ? dataReader(rawData) : rawData;

  let startTime = queryParams["startTime"];
  let stopTime = queryParams["stopTime"];

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from the database
  startTime = dayjs.utc(startTime).startOf(granularity);
  stopTime = dayjs.utc(stopTime).endOf(granularity);

  const series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    yAxisFieldName,
    true,
    smooth,
    sort_by,
    chartType,
    filter,
    isRegex
  );

  // If we have too many series, we'll only show the top N series by total value
  // We group everything else into an "Other" series
  let mergedSeries = series;

  if (max_items_in_series && series.length > max_items_in_series) {
    // take last max_items_in_series items and group the rest into "Other"
    const topX = series.slice(0, max_items_in_series);

    var other = {
      name: "Other",
      type: chartType === "line" ? "line" : "bar",
      stack: "",
      symbol: "circle",
      symbolSize: 4,
      // data is all other series, the data from every series summed up for each timestamp
      // so basically get the field series.data, which is an array [date, value], and sum up the values for each date
      data: series
        .slice(max_items_in_series)
        .map((s) => s.data)
        .reduce((acc, val) => {
          val.forEach((v, i) => {
            if (acc[i] === undefined) {
              acc[i] = v;
            } else {
              // @ts-ignore
              acc[i][1] += v[1];
            }
          });
          return acc;
        }, []),

      emphasis: {
        focus: "series",
      },
      smooth: smooth,
    };
    if (chartType === "stacked_bar") {
      other = {
        ...other,
        stack: "Total",
      };
    }

    // now merge topX and other
    mergedSeries = topX.concat(other);
  }

  return (
    <TimeSeriesPanelWithData
      data={data}
      series={mergedSeries}
      title={title}
      groupByFieldName={groupByFieldName}
      yAxisRenderer={yAxisRenderer}
      yAxisLabel={yAxisLabel}
      timeFieldDisplayFormat={timeFieldDisplayFormat}
      additionalOptions={additionalOptions}
    />
  );
}
