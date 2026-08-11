import TimeSeriesPanel, {
  Granularity,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { EChartsOption } from "echarts";
import {
  FLAKY_TRUNK_REPO,
  getMetricOption,
  intFormatter,
  MetricKey,
  percentFormatter,
} from "./common";
dayjs.extend(utc);

export default function FlakyTrunkGraph({
  startTime,
  stopTime,
  granularity,
  metric,
  onBucketClick,
}: {
  startTime: string;
  stopTime: string;
  granularity: Granularity;
  metric: MetricKey;
  onBucketClick: (_bucketStart: dayjs.Dayjs) => void;
}) {
  const metricOption = getMetricOption(metric);
  const yAxisRenderer = metricOption.isRate ? percentFormatter : intFormatter;

  // Reset the y-axis per metric so rates and counts are never plotted on the
  // same scale: rates are pinned to 0-100%, counts auto-scale from 0.
  const additionalOptions: EChartsOption = metricOption.isRate
    ? { yAxis: { min: 0, max: 1 } }
    : { yAxis: { min: 0 } };

  const onEvents = {
    click: (p: any) => {
      if (!p || !p.value || p.value[0] === undefined) {
        return;
      }
      onBucketClick(dayjs.utc(p.value[0]));
    },
  };

  return (
    <TimeSeriesPanel
      title={`Trunk ${metricOption.label} per ${granularity}`}
      queryName={"flaky_trunk_timeseries"}
      queryParams={{
        startTime,
        stopTime,
        repo: FLAKY_TRUNK_REPO,
      }}
      granularity={granularity}
      timeFieldName={"bucket"}
      yAxisFieldName={metric}
      yAxisLabel={metricOption.label}
      yAxisRenderer={yAxisRenderer}
      additionalOptions={additionalOptions}
      chartType={"line"}
      timeFieldDisplayFormat={"M/D (UTC)"}
      useUTC={true}
      auto_refresh={false}
      onEvents={onEvents}
    />
  );
}
