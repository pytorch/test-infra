import TimeSeriesPanel, {
  Granularity,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { EChartsOption } from "echarts";
import React, { useMemo } from "react";
import {
  DenominatorKey,
  FLAKE_SLICES,
  FLAKY_TRUNK_REPO,
  getDenominatorOption,
  percentFormatter,
} from "./common";
dayjs.extend(utc);

// Percentages auto-scale to the data (scale: true) instead of being pinned to
// 0-100%, so a low single-digit flake rate is still readable.
const AUTO_SCALE_PCT_AXIS: EChartsOption = { yAxis: { scale: true } };

function FlakyTrunkGraph({
  startTime,
  stopTime,
  granularity,
  denominator,
  onBucketClick,
}: {
  startTime: string;
  stopTime: string;
  granularity: Granularity;
  denominator: DenominatorKey;
  onBucketClick: (_bucketStart: dayjs.Dayjs) => void;
}) {
  // Stable across denominator changes so echarts-for-react (which disposes the
  // chart when onEvents is not deep-equal) does a smooth update instead of a
  // full rebuild.
  const onEvents = useMemo(
    () => ({
      click: (p: any) => {
        if (!p || !p.value || p.value[0] === undefined) {
          return;
        }
        onBucketClick(dayjs.utc(p.value[0]));
      },
    }),
    [onBucketClick]
  );

  const denomField = getDenominatorOption(denominator).field;

  // Melt each per-bucket count row into one row per slice, dividing the slice
  // count by the chosen denominator. This runs on the already-fetched (cached)
  // rows, so switching the denominator recomputes without a refetch.
  const dataReader = useMemo(
    () => (rawData: { [k: string]: any }[]) => {
      const melted: { [k: string]: any }[] = [];
      for (const row of rawData) {
        const denom = Number(row[denomField]) || 0;
        for (const slice of FLAKE_SLICES) {
          melted.push({
            bucket: row.bucket,
            series: slice.label,
            pct: denom === 0 ? 0 : Number(row[slice.key]) / denom,
          });
        }
      }
      return melted;
    },
    [denomField]
  );

  return (
    <TimeSeriesPanel
      title={`Trunk flakiness (${getDenominatorOption(denominator).label})`}
      queryName={"flaky_trunk_timeseries"}
      queryParams={{
        startTime,
        stopTime,
        repo: FLAKY_TRUNK_REPO,
      }}
      granularity={granularity}
      groupByFieldName={"series"}
      timeFieldName={"bucket"}
      yAxisFieldName={"pct"}
      yAxisLabel={"% flaky"}
      yAxisRenderer={percentFormatter}
      additionalOptions={AUTO_SCALE_PCT_AXIS}
      chartType={"stacked_bar"}
      sort_by={"name"}
      dataReader={dataReader}
      timeFieldDisplayFormat={"M/D (UTC)"}
      useUTC={true}
      auto_refresh={false}
      onEvents={onEvents}
    />
  );
}

export default React.memo(FlakyTrunkGraph);
