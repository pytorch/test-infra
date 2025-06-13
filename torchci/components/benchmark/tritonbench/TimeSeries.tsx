import { Card, CardContent, CardHeader, Grid2, Skeleton } from "@mui/material";
import { styled } from "@mui/material/styles";
import { TIME_FIELD_NAME } from "components/benchmark/common";
import { COMMIT_TO_WORKFLOW_ID } from "components/benchmark/RepositoryPicker";
import {
  Granularity,
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import {
  BENCHMARK_METRIC_DASHBOARD_MAPPING,
  BENCHMARK_METRIC_DASHBOARD_Y_LABEL,
  BENCHMARK_NAME_METRICS_MAPPING,
} from "components/tritonbench/common";
import dayjs from "dayjs";
import { computeMetric } from "lib/benchmark/tritonbench/metricUtils";
import { fetcher } from "lib/GeneralUtils";
import { RepoBranchAndCommit } from "lib/types";
import useSWR from "swr";

/** Mui Styles */
const GraphCardGroup = styled(Card)({
  margin: "5px",
});
/** Mui Styles */

function TimeSeriesGraphPanel({
  queryName,
  queryParams,
  granularity,
  repo,
  suite,
  metricName,
  branch,
  lCommit,
  rCommit,
}: {
  queryName: string;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  repo: string;
  suite: string;
  metricName: string;
  branch: string;
  lCommit: string;
  rCommit: string;
}) {
  return (
    <>
      <GraphCardGroup>
        <CardHeader title={`Suite: TritonBench`} />
        <CardContent>
          <SingleGraphPanel
            queryName={queryName}
            queryParams={queryParams}
            granularity={granularity}
            repo={repo}
            suite={suite}
            metricName={metricName}
            branch={branch}
            lCommit={lCommit}
            rCommit={rCommit}
          />
        </CardContent>
      </GraphCardGroup>
    </>
  );
}

const GRAPH_ROW_HEIGHT = 245;

function SingleGraphPanel({
  queryName,
  queryParams,
  granularity,
  repo,
  suite,
  metricName,
  branch,
  lCommit,
  rCommit,
}: {
  queryName: string;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  repo: string;
  suite: string;
  metricName: string;
  branch: string;
  lCommit: string;
  rCommit: string;
}) {
  const queryParamsWithSuite: { [key: string]: any } = {
    ...queryParams,
    repo: repo,
    suite: suite,
    metric_name: metricName,
    branch: branch,
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

  const groupByFieldName = undefined;
  // Only show records between these twos
  const lWorkflowId = COMMIT_TO_WORKFLOW_ID[lCommit];
  const rWorkflowId = COMMIT_TO_WORKFLOW_ID[rCommit];

  const metricData = computeMetric(data).filter((r: any) => {
    const id = r.workflow_id;
    const op_name = r.operator;
    // low_mem_dropout tflops is too low and we have to exclude it from the dashboard
    // to avoid all zero numbers
    return (
      ((id >= lWorkflowId && id <= rWorkflowId) ||
        (id <= lWorkflowId && id >= rWorkflowId)) &&
      op_name !== "low_mem_dropout"
    );
  });

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from the database
  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

  const metricTimeSeries = seriesWithInterpolatedTimes(
    metricData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "metric_value",
    false
  );

  return (
    <>
      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
          <TimeSeriesPanelWithData
            data={metricData}
            series={metricTimeSeries}
            title={BENCHMARK_METRIC_DASHBOARD_MAPPING[metricName]}
            groupByFieldName={groupByFieldName}
            yAxisRenderer={(unit) => {
              return `${(unit * 1).toFixed(0)}`;
            }}
            yAxisLabel={BENCHMARK_METRIC_DASHBOARD_Y_LABEL[metricName]}
            additionalOptions={{
              yAxis: {
                scale: true,
              },
              label: {
                show: true,
                align: "left",
                formatter: (r: any) => {
                  return (r.value[1] * 1).toFixed(0);
                },
              },
            }}
            legendPadding={310}
          />
        </Grid2>
      </Grid2>
    </>
  );
}

export function TimeSeriesGraphReport({
  queryParams,
  granularity,
  benchmarkName,
  lRepoBranchAndCommit,
  rRepoBranchAndCommit,
}: {
  queryParams: { [key: string]: any };
  granularity: Granularity;
  benchmarkName: string;
  lRepoBranchAndCommit: RepoBranchAndCommit;
  rRepoBranchAndCommit: RepoBranchAndCommit;
}) {
  return (
    <>
      <TimeSeriesGraphPanel
        queryName="tritonbench_benchmark"
        queryParams={queryParams}
        granularity={granularity}
        repo={lRepoBranchAndCommit.repo}
        suite={"tritonbench-oss"}
        metricName={BENCHMARK_NAME_METRICS_MAPPING[benchmarkName][0]}
        branch={lRepoBranchAndCommit.branch}
        lCommit={lRepoBranchAndCommit.commit}
        rCommit={rRepoBranchAndCommit.commit}
      />
    </>
  );
}
