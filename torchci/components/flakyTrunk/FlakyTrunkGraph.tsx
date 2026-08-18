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

// Bars start at zero so low rates are not visually truncated; the max still
// auto-scales to the data, so single-digit percentages stay readable.
const PCT_AXIS_FROM_ZERO: EChartsOption = { yAxis: { min: 0 } };

function FlakyTrunkGraph({
  startTime,
  stopTime,
  granularity,
  denominator,
  viableStrictOnly,
  onBucketClick,
  autoRefresh,
}: {
  startTime: string;
  stopTime: string;
  granularity: Granularity;
  denominator: DenominatorKey;
  viableStrictOnly: boolean;
  onBucketClick: (_bucketStart: dayjs.Dayjs) => void;
  autoRefresh: boolean;
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
        viableStrictOnly,
      }}
      granularity={granularity}
      groupByFieldName={"series"}
      timeFieldName={"bucket"}
      yAxisFieldName={"pct"}
      yAxisLabel={"% flaky"}
      yAxisRenderer={percentFormatter}
      additionalOptions={PCT_AXIS_FROM_ZERO}
      chartType={"stacked_bar"}
      sort_by={"name"}
      dataReader={dataReader}
      timeFieldDisplayFormat={"M/D (UTC)"}
      useUTC={true}
      auto_refresh={autoRefresh}
      onEvents={onEvents}
    />
  );
}

export default React.memo(FlakyTrunkGraph);
