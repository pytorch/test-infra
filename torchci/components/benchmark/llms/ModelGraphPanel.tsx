import { Grid, Stack, Typography } from "@mui/material";
import {
  COMMIT_TO_WORKFLOW_ID,
  WORKFLOW_ID_TO_COMMIT,
} from "components/benchmark/BranchAndCommitPicker";
import { TIME_FIELD_NAME } from "components/benchmark/common";
import {
  DEFAULT_MODEL_NAME,
  LLMsBenchmarkData,
  METRIC_DISPLAY_HEADERS,
  METRIC_DISPLAY_SHORT_HEADERS,
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
  deviceName,
  metricNames,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  modelName: string;
  deviceName: string;
  metricNames: string[];
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  // Do not set the commit here to query all the records in the time range to
  // draw a chart
  const { data, error } = useBenchmark(queryParams, modelName, deviceName, {
    branch: rBranchAndCommit.branch,
    commit: "",
  });

  if (data === undefined || data.length === 0) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading chart for {modelName}...
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

  const chartData: { [k: string]: any } = {};
  const graphSeries: { [k: string]: any } = {};
  metricNames.forEach((metric: string) => {
    chartData[metric] = data
      .filter(
        (record: LLMsBenchmarkData) =>
          record.name === modelName && record.metric === metric
      )
      .filter((record: LLMsBenchmarkData) => {
        const id = record.workflow_id;
        return (
          (id >= lWorkflowId && id <= rWorkflowId) ||
          (id <= lWorkflowId && id >= rWorkflowId)
        );
      });
    graphSeries[metric] = seriesWithInterpolatedTimes(
      chartData[metric],
      startTime,
      stopTime,
      granularity,
      groupByFieldName,
      TIME_FIELD_NAME,
      "actual",
      false
    );
  });

  return (
    <>
      <div>
        <Grid container spacing={2}>
          {metricNames.map((metric: string) => (
            <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT} key={metric}>
              {chartData[metric].length !== 0 && (
                <TimeSeriesPanelWithData
                  data={chartData[metric]}
                  series={graphSeries[metric]}
                  title={
                    metric in METRIC_DISPLAY_HEADERS
                      ? METRIC_DISPLAY_HEADERS[metric]
                      : metric
                  }
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
              )}
            </Grid>
          ))}
        </Grid>
      </div>
      <div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Commit</th>
              {metricNames.map((metric: string) => (
                <th key={metric}>
                  {chartData[metric].length !== 0
                    ? metric in METRIC_DISPLAY_SHORT_HEADERS
                      ? METRIC_DISPLAY_SHORT_HEADERS[metric]
                      : metric
                    : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chartData[metricNames[0]].map((entry: any, index: number) => {
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
                  {metricNames.map((metric: string) => (
                    <td key={`${metric}-${index}`}>
                      {chartData[metric][index] !== undefined
                        ? chartData[metric][index].actual
                        : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
