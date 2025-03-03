import { Grid2, Skeleton } from "@mui/material";
import { COMMIT_TO_WORKFLOW_ID } from "components/benchmark/BranchAndCommitPicker";
import { TIME_FIELD_NAME } from "components/benchmark/common";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import {
  Granularity,
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import {
  computeCompilationTime,
  computeExecutionTime,
  computeGeomean,
  computeMemoryCompressionRatio,
  computePassrate,
  computePeakMemoryUsage,
  convertToCompilerPerformanceData,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

const GRAPH_ROW_HEIGHT = 245;

export function GraphPanel({
  queryName,
  queryParams,
  granularity,
  suite,
  branch,
  lCommit,
  rCommit,
}: {
  queryName: string;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  suite: string;
  branch: string;
  lCommit: string;
  rCommit: string;
}) {
  // NB: I need to do multiple queries here for different suites to keep the response
  // from the database small enough (<6MB) to fit into Vercel lambda limit
  return (
    <SuiteGraphPanel
      queryName={queryName}
      queryParams={queryParams}
      granularity={granularity}
      suite={suite}
      branch={branch}
      lCommit={lCommit}
      rCommit={rCommit}
    />
  );
}

function SuiteGraphPanel({
  queryName,
  queryParams,
  granularity,
  suite,
  branch,
  lCommit,
  rCommit,
}: {
  queryName: string;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  suite: string;
  branch: string;
  lCommit: string;
  rCommit: string;
}) {
  const queryParamsWithSuite: { [key: string]: any } = {
    ...queryParams,
    branches: [branch],
    suites: [suite],
  };
  // NB: Querying data for all the suites blows up the response from the database
  // over the lambda reponse body limit of 6MB. So I need to split up the query
  // here into multiple smaller ones to keep them under the limit
  //
  // See more:
  // * https://nextjs.org/docs/messages/api-routes-body-size-limit
  // * https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithSuite)
  )}`;

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }

  if (data === undefined || data.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // TODO (huydhn): Remove this once TorchInductor dashboard is migrated to the
  // new database schema
  data =
    queryName === "torchao_query"
      ? convertToCompilerPerformanceData(data)
      : data;

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from the database
  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

  // Compute the metrics for all passing models
  const models = getPassingModels(data);
  const groupByFieldName = "compiler";

  // Only show records between these twos
  const lWorkflowId = COMMIT_TO_WORKFLOW_ID[lCommit];
  const rWorkflowId = COMMIT_TO_WORKFLOW_ID[rCommit];

  // Accuracy
  const passrate = computePassrate(data, models).filter((r: any) => {
    const id = r.workflow_id;
    return (
      (id >= lWorkflowId && id <= rWorkflowId) ||
      (id <= lWorkflowId && id >= rWorkflowId)
    );
  });
  const passrateSeries = seriesWithInterpolatedTimes(
    passrate,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "passrate",
    false
  );
  const totalModelCountSeries = seriesWithInterpolatedTimes(
    passrate,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "total_count",
    false
  );

  // Geomean speedup
  const geomean = computeGeomean(data, models).filter((r: any) => {
    const id = r.workflow_id;
    return (
      (id >= lWorkflowId && id <= rWorkflowId) ||
      (id <= lWorkflowId && id >= rWorkflowId)
    );
  });
  const geomeanSeries = seriesWithInterpolatedTimes(
    geomean,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "geomean",
    false
  );

  // Compilation time
  const compTime = computeCompilationTime(data, models).filter((r: any) => {
    const id = r.workflow_id;
    return (
      (id >= lWorkflowId && id <= rWorkflowId) ||
      (id <= lWorkflowId && id >= rWorkflowId)
    );
  });
  const compTimeSeries = seriesWithInterpolatedTimes(
    compTime,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compilation_latency",
    false
  );

  // Execution time
  const executionTime = computeExecutionTime(data, models).filter((r: any) => {
    const id = r.workflow_id;
    return (
      (id >= lWorkflowId && id <= rWorkflowId) ||
      (id <= lWorkflowId && id >= rWorkflowId)
    );
  });
  const executionTimeSeries = seriesWithInterpolatedTimes(
    executionTime,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "abs_latency",
    false
  );

  // Memory compression ratio
  const memory = computeMemoryCompressionRatio(data, models).filter(
    (r: any) => {
      const id = r.workflow_id;
      return (
        (id >= lWorkflowId && id <= rWorkflowId) ||
        (id <= lWorkflowId && id >= rWorkflowId)
      );
    }
  );
  const memorySeries = seriesWithInterpolatedTimes(
    memory,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compression_ratio",
    false
  );

  // Dynamo peak memory usage
  const peakMemory = computePeakMemoryUsage(data, models).filter((r: any) => {
    const id = r.workflow_id;
    return (
      (id >= lWorkflowId && id <= rWorkflowId) ||
      (id <= lWorkflowId && id >= rWorkflowId)
    );
  });
  const peakMemorySeries = seriesWithInterpolatedTimes(
    peakMemory,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "dynamo_peak_mem",
    false
  );

  return (
    <Grid2 container spacing={2}>
      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={passrate}
          series={passrateSeries}
          title={`Passrate / ${SUITES[suite]}`}
          yAxisLabel={"%"}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${(unit * 100).toFixed(0)} %`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return (r.value[1] * 100).toFixed(0);
              },
            },
          }}
          legendPadding={310}
        />
      </Grid2>

      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={passrate}
          series={totalModelCountSeries}
          title={`Number of Models / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return r.value[1];
              },
            },
          }}
          legendPadding={310}
        />
      </Grid2>

      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={geomean}
          series={geomeanSeries}
          title={`Geomean / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
              min: 1.0,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return r.value[1];
              },
            },
          }}
          legendPadding={310}
        />
      </Grid2>

      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={compTime}
          series={compTimeSeries}
          title={`Mean compilation time / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisLabel={"second"}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return Number(r.value[1]).toFixed(0);
              },
            },
          }}
          legendPadding={310}
        />
      </Grid2>

      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={memory}
          series={memorySeries}
          title={`Peak memory footprint compression ratio / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return r.value[1];
              },
            },
          }}
          legendPadding={310}
        />
      </Grid2>

      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={peakMemory}
          series={peakMemorySeries}
          title={`Peak dynamo memory usage / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisLabel={"GB"}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return r.value[1];
              },
            },
          }}
          legendPadding={310}
        />
      </Grid2>

      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={executionTime}
          series={executionTimeSeries}
          title={`Execution time / ${SUITES[suite]}`}
          groupByFieldName={groupByFieldName}
          yAxisLabel={"second"}
          yAxisRenderer={(unit) => {
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return Number(r.value[1]).toFixed(0);
              },
            },
          }}
          legendPadding={310}
        />
      </Grid2>
    </Grid2>
  );
}
