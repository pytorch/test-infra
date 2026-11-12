import { Grid, Skeleton } from "@mui/material";
import { TIME_FIELD_NAME } from "components/benchmark/common";
import {
  Granularity,
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import _ from "lodash";
import useSWR from "swr";

const GRAPH_ROW_HEIGHT = 245;
const QUERY_NAME = "compilers_benchmark_compile_time_breakdown";

// Stacking order, bottom to top
const PHASES: { [field: string]: string } = {
  dynamo: "Dynamo",
  aot_autograd: "AOTAutograd",
  inductor: "Inductor",
  other: "Other",
};

interface CompileTimeBreakdown {
  workflow_id: number;
  granularity_bucket: string;
  model: string;
  [phase: string]: number | string;
}

// One row per (bucket, phase) with the value averaged over the given records
function toPhaseRows(records: CompileTimeBreakdown[]) {
  // Jobs in one workflow can land in different buckets, keep the earliest one
  // like convertToCompilerPerformanceData does
  const byWorkflow = _.groupBy(records, (r) => r.workflow_id);
  return _.flatMap(byWorkflow, (rows) => {
    const bucket = _.minBy(
      rows,
      (r) => r.granularity_bucket
    )!.granularity_bucket;
    return Object.entries(PHASES).map(([field, phase]) => ({
      [TIME_FIELD_NAME]: bucket,
      phase,
      value: Number(_.meanBy(rows, (r) => r[field] as number).toFixed(2)),
    }));
  });
}

function BreakdownGraph({
  title,
  rows,
  startTime,
  stopTime,
  granularity,
}: {
  title: string;
  rows: any[];
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
}) {
  const order = Object.values(PHASES);
  const series = _.sortBy(
    seriesWithInterpolatedTimes(
      rows,
      startTime,
      stopTime,
      granularity,
      "phase",
      TIME_FIELD_NAME,
      "value",
      false,
      false,
      "name",
      "stacked_bar"
    ),
    (s) => order.indexOf(s.name)
  );
  return (
    <TimeSeriesPanelWithData
      data={rows}
      series={series}
      title={title}
      groupByFieldName="phase"
      yAxisLabel="second"
      yAxisRenderer={(unit) => `${unit.toFixed(0)}`}
      additionalOptions={{ tooltip: { trigger: "axis" } }}
    />
  );
}

export function CompileTimeBreakdownPanel({
  queryParams,
  granularity,
  suite,
  compiler,
  model,
  branch,
}: {
  queryParams: { [key: string]: any };
  granularity: Granularity;
  suite: string;
  compiler: string;
  model: string | undefined;
  branch: string;
}) {
  const params = {
    ...queryParams,
    branches: [branch],
    suites: [suite],
    compilers: [compiler],
  };
  const url = `/api/clickhouse/${QUERY_NAME}?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;
  const { data } = useSWR<CompileTimeBreakdown[]>(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={GRAPH_ROW_HEIGHT} />;
  }
  // The phase timers are only uploaded by some configs, e.g. not AOTInductor
  if (data.length === 0) {
    return <></>;
  }

  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);
  const modelRows =
    model === undefined
      ? []
      : toPhaseRows(data.filter((r) => r.model === model));

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <BreakdownGraph
          title={`Mean compilation time breakdown / ${suite}`}
          rows={toPhaseRows(data)}
          startTime={startTime}
          stopTime={stopTime}
          granularity={granularity}
        />
      </Grid>
      {modelRows.length > 0 && (
        <Grid size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
          <BreakdownGraph
            title={`Compilation time breakdown / ${model}`}
            rows={modelRows}
            startTime={startTime}
            stopTime={stopTime}
            granularity={granularity}
          />
        </Grid>
      )}
    </Grid>
  );
}
