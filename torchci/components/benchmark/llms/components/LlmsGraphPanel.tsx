import { Grid2, Stack, Typography } from "@mui/material";
import {
  COMMIT_TO_WORKFLOW_ID,
  WORKFLOW_ID_TO_COMMIT,
} from "components/benchmark/BranchAndCommitPicker";
import { TIME_FIELD_NAME } from "components/benchmark/common";

import {
  Granularity,
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { BranchAndCommit } from "lib/types";
import {
  computeSpeedup,
  TORCHAO_SPEEDUP_METRIC_NAMES,
} from "../../../../lib/benchmark/llms/aoUtils";
import {
  computeGeomean,
  useBenchmark,
} from "../../../../lib/benchmark/llms/llmUtils";
import { DEFAULT_DEVICE_NAME, DEFAULT_MODEL_NAME } from "../llmsPickerHelper";
import { LLMsBenchmarkData, METRIC_DISPLAY_HEADERS, METRIC_DISPLAY_SHORT_HEADERS } from "lib/benchmark/llms/common";

const GRAPH_ROW_HEIGHT = 245;

export function LLMsGraphPanel({
  queryParams,
  granularity,
  repoName,
  benchmarkName,
  modelName,
  backendName,
  dtypeName,
  deviceName,
  metricNames,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: { [key: string]: any };
  granularity: Granularity;
  repoName: string;
  benchmarkName: string;
  modelName: string;
  backendName: string;
  dtypeName: string;
  deviceName: string;
  metricNames: string[];
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  // Do not set the commit here to query all the records in the time range to
  // draw a chart
  const { data, error } = useBenchmark(queryParams, {
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

  const dataWithSpeedup = computeSpeedup(
    repoName,
    computeSpeedup(repoName, data, false, true),
    true,
    false
  );

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from the database
  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

  // Only show records between these twos
  const lWorkflowId = COMMIT_TO_WORKFLOW_ID[lBranchAndCommit.commit];
  const rWorkflowId = COMMIT_TO_WORKFLOW_ID[rBranchAndCommit.commit];

  const groupByFieldName = "display";

  const chartData: { [k: string]: any } = {};
  const graphSeries: { [k: string]: any } = {};
  metricNames.forEach((metric: string) => {
    if (
      modelName === DEFAULT_MODEL_NAME &&
      !TORCHAO_SPEEDUP_METRIC_NAMES.includes(metric)
    ) {
      chartData[metric] = [];
      return;
    }

    const geomean = computeGeomean(dataWithSpeedup, metric);
    chartData[metric] =
      modelName === DEFAULT_MODEL_NAME
        ? geomean
            .filter((record: LLMsBenchmarkData) => {
              const id = record.workflow_id;
              return (
                (id >= lWorkflowId && id <= rWorkflowId) ||
                (id <= lWorkflowId && id >= rWorkflowId) ||
                (lWorkflowId === undefined && rWorkflowId === undefined) ||
                // This is a hack to handle the mock workflow ID coming from running TorchAO benchmark locally
                // In such caase, the workflow ID is actually the epoch timestamp and the value is completely
                // different than the regular GitHub workflow ID
                0.5 > rWorkflowId / lWorkflowId ||
                rWorkflowId / lWorkflowId > 2
              );
            })
            .map((record: LLMsBenchmarkData) => {
              const origins =
                record.origins.length !== 0
                  ? `${record.origins.join(",")} `
                  : "";
              record.display = `${origins}${record.dtype} @ ${record.device} (${record.arch})`;
              return record;
            })
        : dataWithSpeedup
            .filter((record: LLMsBenchmarkData) => {
              return (
                record.model === modelName &&
                (`${record.device} (${record.arch})` === deviceName ||
                  deviceName === DEFAULT_DEVICE_NAME) &&
                record.metric === metric
              );
            })
            .filter((record: LLMsBenchmarkData) => {
              const id = record.workflow_id;
              return (
                (id >= lWorkflowId && id <= rWorkflowId) ||
                (id <= lWorkflowId && id >= rWorkflowId) ||
                (lWorkflowId === undefined && rWorkflowId === undefined)
              );
            })
            .map((record: LLMsBenchmarkData) => {
              const model = record.model;
              const dtype = record.dtype;
              const device = record.device;
              const metric = record.metric;

              if (repoName === "vllm-project/vllm") {
                let requestRate = record.extra!["request_rate"];
                // TODO (huydhn): Fix the invalid JSON on vLLM side
                if (
                  metric.includes("itl") ||
                  metric.includes("tpot") ||
                  metric.includes("ttft")
                ) {
                  requestRate = requestRate !== "" ? requestRate : "Inf";
                }

                let tensorParallel = record.extra!["tensor_parallel_size"];
                // TODO (huydhn): Fix the passing of tensor_parallel_size to the benchmark
                // script on vLLM side
                if (model.includes("8B")) {
                  tensorParallel = tensorParallel !== "" ? tensorParallel : "1";
                } else if (model.includes("70B")) {
                  tensorParallel = tensorParallel !== "" ? tensorParallel : "4";
                } else if (model.includes("8x7B")) {
                  tensorParallel = tensorParallel !== "" ? tensorParallel : "2";
                }

                if (requestRate !== "") {
                  record.display = `${model} / tp${tensorParallel} / qps_${requestRate}`;
                } else {
                  record.display = `${model} / tp${tensorParallel}`;
                }
              } else if (
                repoName === "pytorch/pytorch" &&
                benchmarkName === "TorchCache Benchmark"
              ) {
                const isDynamic = record.extra!["is_dynamic"];
                record.display = `${model} / ${isDynamic}`;
              } else {
                record.display = model.includes(dtype)
                  ? model.includes(device)
                    ? model
                    : `${model} (${device})`
                  : model.includes(device)
                  ? `${model} (${dtype})`
                  : `${model} (${dtype} / ${device})`;
              }

              return record;
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

  const availableMetric =
    metricNames.find((metric) => chartData[metric].length !== 0) ??
    metricNames[0];

  return (
    <>
      <div>
        <Grid2 container spacing={2}>
          {metricNames
            .filter((metric) => chartData[metric].length !== 0)
            .map((metric: string) => (
              <Grid2
                size={{ xs: 12, lg: modelName === DEFAULT_MODEL_NAME ? 12 : 6 }}
                height={GRAPH_ROW_HEIGHT}
                key={metric}
              >
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
                  legendPadding={320}
                />
              </Grid2>
            ))}
        </Grid2>
      </div>
      {modelName !== DEFAULT_MODEL_NAME && (
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
              {chartData[availableMetric].map((entry: any, index: number) => {
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
                    {metricNames
                      .filter((metric) => chartData[metric].length !== 0)
                      .map((metric: string) => (
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
      )}
    </>
  );
}
