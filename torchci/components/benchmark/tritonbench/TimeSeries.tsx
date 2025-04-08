import { Grid2, Skeleton } from "@mui/material";
import { Card, CardContent, CardHeader } from "@mui/material";
import dayjs from "dayjs";
import { COMMIT_TO_WORKFLOW_ID } from "components/benchmark/BranchAndCommitPicker";
import { TIME_FIELD_NAME } from "components/benchmark/common";
import { styled } from "@mui/material/styles";
import {
  Granularity,
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import { BranchAndCommit } from "lib/types";
import { computeCompileTime } from "lib/benchmark/tritonbench/compileTimeUtils"
import { fetcher } from "lib/GeneralUtils";
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
  metric_name,
  branch,
  lCommit,
  rCommit,
}:{
  queryName: string;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  repo: string;
  suite: string;
  metric_name: string;
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
            metric_name={metric_name}
            branch={branch}
            lCommit={lCommit}
            rCommit={rCommit}
          />
        </CardContent>
      </GraphCardGroup>
      </>
    );
};

const GRAPH_ROW_HEIGHT = 245;

function SingleGraphPanel({
    queryName,
    queryParams,
    granularity,
    repo,
    suite,
    metric_name,
    branch,
    lCommit,
    rCommit,
}:{
    queryName: string;
    queryParams: { [key: string]: any };
    granularity: Granularity;
    repo: string;
    suite: string;
    metric_name: string;
    branch: string;
    lCommit: string;
    rCommit: string;
}) {
    const queryParamsWithSuite: { [key: string]: any } = {
      ...queryParams,
      repo: repo,
      suite: suite,
      metric_name: metric_name,
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
    
    const compileTime = computeCompileTime(data).filter((r: any) => {
      const id = r.workflow_id;
      return (
        (id >= lWorkflowId && id <= rWorkflowId) ||
        (id <= lWorkflowId && id >= rWorkflowId)
      );
    });

    // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
    // align with the data we get from the database
    const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
    const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

    const compileTimeSeries = seriesWithInterpolatedTimes(
        compileTime,
        startTime,
        stopTime,
        granularity,
        groupByFieldName,
        TIME_FIELD_NAME,
        "compilation_latency",
        false
    );

  return (
    <>
    <Grid2 container spacing={2}>
      <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={compileTime}
          series={compileTimeSeries}
          title={`Average Compile Time}`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${(unit * 1).toFixed(0)} ms`;
          }}
          yAxisLabel={"ms"}
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
    )
}

export function TimeSeriesGraphReport({
  queryParams,
  granularity,
  lBranchAndCommit,
  rBranchAndCommit,
}:{
  queryParams: { [key: string]: any };
  granularity: Granularity;
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  return (
    <>
    <TimeSeriesGraphPanel
      queryName="tritonbench_benchmark"
      queryParams={queryParams}
      granularity={granularity}
      repo={"pytorch-labs/tritonbench"}
      suite={"tritonbench-oss"}
      metric_name={"compile_time-avg"}
      branch={lBranchAndCommit.branch}
      lCommit={lBranchAndCommit.commit}
      rCommit={rBranchAndCommit.commit}
    />
    </>
  );
}