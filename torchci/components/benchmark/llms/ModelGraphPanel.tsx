import { Grid, Stack, Typography } from "@mui/material";
import {
  COMMIT_TO_WORKFLOW_ID,
  WORKFLOW_ID_TO_COMMIT,
} from "components/benchmark/BranchAndCommitPicker";
import { TIME_FIELD_NAME } from "components/benchmark/common";
import {
  DEFAULT_MODEL_NAME,
  LLMsBenchmarkData,
} from "components/benchmark/llms/common";
import {
  Granularity,
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { useBenchmark } from "lib/benchmark/llmUtils";
import { RocksetParam } from "lib/rockset";
import { BranchAndCommit } from "lib/types";

const GRAPH_ROW_HEIGHT = 245;

export function GraphPanel({
  queryParams,
  granularity,
  modelName,
  quantization,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  modelName: string;
  quantization: string;
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  // Do not set the commit here to query all the records in the time range to
  // draw a chart
  const { data, error } = useBenchmark(queryParams, modelName, quantization, {
    branch: rBranchAndCommit.branch,
    commit: "",
  });

  if (data === undefined || data.length === 0) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading chart for {modelName} quantized in {quantization}...
        </Typography>
      </Stack>
    );
  }

  if (modelName === DEFAULT_MODEL_NAME) {
    return <></>;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  // Only show records between these twos
  const lWorkflowId = COMMIT_TO_WORKFLOW_ID[lBranchAndCommit.commit];
  const rWorkflowId = COMMIT_TO_WORKFLOW_ID[rBranchAndCommit.commit];

  const groupByFieldName = "name";
  const chartData = data
    .filter((record: LLMsBenchmarkData) => record.name === modelName)
    .filter((record: LLMsBenchmarkData) => {
      const id = record.workflow_id;
      return (
        (id >= lWorkflowId && id <= rWorkflowId) ||
        (id <= lWorkflowId && id >= rWorkflowId)
      );
    });

  const tpsSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "token_per_sec[actual]",
    false
  );

  const memoryBandwidthSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "memory_bandwidth[actual]",
    false
  );

  return (
    <>
      <div>
        <Grid container spacing={2}>
          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={tpsSeries}
              title={"Token per second"}
              groupByFieldName={groupByFieldName}
              yAxisRenderer={(unit) => unit}
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
            />
          </Grid>

          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={memoryBandwidthSeries}
              title={"Memory bandwidth (GB/s)"}
              groupByFieldName={groupByFieldName}
              yAxisLabel={"GB/s"}
              yAxisRenderer={(unit) => unit}
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
            />
          </Grid>
        </Grid>
      </div>
      <div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Commit</th>
              <th>TPS</th>
              <th>Bandwidth</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((entry: any, index: number) => {
              let commit = WORKFLOW_ID_TO_COMMIT[entry.workflow_id];
              return (
                <tr key={index}>
                  <td>{entry.granularity_bucket}</td>
                  <td>
                    <code>
                      <a
                        onClick={() => navigator.clipboard.writeText(commit)}
                        className="animate-on-click"
                      >
                        {commit}
                      </a>
                    </code>
                  </td>
                  <td>{entry["token_per_sec[actual]"]}</td>
                  <td>{entry["memory_bandwidth[actual]"]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
