import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Box,
  Button,
  Grid,
  IconButton,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
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
import {
  DEFAULT_DEVICE_NAME,
  DEFAULT_MODEL_NAME,
  LLMsBenchmarkData,
  METRIC_DISPLAY_HEADERS,
  METRIC_DISPLAY_SHORT_HEADERS,
} from "lib/benchmark/llms/common";
import { TORCHAO_SPEEDUP_METRIC_NAMES } from "lib/benchmark/llms/utils/aoUtils";
import { computeGeomean } from "lib/benchmark/llms/utils/llmUtils";
import { arrayToCSV, downloadCSV, generateCSVFilename } from "lib/csvUtils";
import { BranchAndCommit } from "lib/types";

const GRAPH_ROW_HEIGHT = 245;

export default function LLMsGraphPanelBase({
  queryParams,
  granularity,
  repoName,
  benchmarkName,
  modelName,
  deviceName,
  metricNames,
  lBranchAndCommit,
  rBranchAndCommit,
  dataWithSpeedup,
  isCompare,
}: {
  queryParams: { [key: string]: any };
  granularity: Granularity;
  repoName: string;
  benchmarkName: string;
  modelName: string;
  deviceName: string;
  metricNames: string[];
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
  dataWithSpeedup: any[];
  isCompare: boolean;
}) {
  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

  const lWorkflowId = COMMIT_TO_WORKFLOW_ID[lBranchAndCommit.commit];
  const rWorkflowId = COMMIT_TO_WORKFLOW_ID[rBranchAndCommit.commit];

  const groupByFieldName = "group_key";

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
                isCompare ||
                (id >= lWorkflowId && id <= rWorkflowId) ||
                (id <= lWorkflowId && id >= rWorkflowId) ||
                (lWorkflowId === undefined && rWorkflowId === undefined) ||
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
                isCompare ||
                (id >= lWorkflowId && id <= rWorkflowId) ||
                (id <= lWorkflowId && id >= rWorkflowId) ||
                (lWorkflowId === undefined && rWorkflowId === undefined)
              );
            })
            .map((record: LLMsBenchmarkData) => {
              const model = record.model;
              const dtype = record.dtype;
              const device = record.device;
              const srcRepo =
                (record as any)?.extra?.["source_repo"] || repoName;
              if (
                srcRepo === "vllm-project/vllm" ||
                srcRepo === "sgl-project/sglang"
              ) {
                const requestRate = record.extra!["request_rate"];
                const tensorParallel = record.extra!["tensor_parallel_size"];
                const inputLen = record.extra!["random_input_len"]
                  ? record.extra!["random_input_len"]
                  : record.extra!["input_len"];
                const outputLen = record.extra!["random_output_len"]
                  ? record.extra!["random_output_len"]
                  : record.extra!["output_len"];

                record.display = `${model} / tp${tensorParallel}`;
                if (requestRate) {
                  record.display = `${record.display} / qps_${requestRate}`;
                }
                if (inputLen) {
                  record.display = `${record.display} / in_${inputLen}`;
                }
                if (outputLen) {
                  record.display = `${record.display} / out_${outputLen}`;
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
    const graphItems = formGraphItem(chartData[metric]);
    graphSeries[metric] = seriesWithInterpolatedTimes(
      graphItems,
      startTime,
      stopTime,
      granularity,
      groupByFieldName,
      TIME_FIELD_NAME,
      "actual",
      false
    );

    // Apply dashed line style for SGLang in the comparison dashboard
    // to easily distinguish it from the vLLM series
    graphSeries[metric] = graphSeries[metric].map((series: any) => {
      if (series.name && series.name.toLowerCase().includes("sglang")) {
        return {
          ...series,
          lineStyle: {
            type: "dashed",
            width: 2,
          },
        };
      }
      return series;
    });
  });

  const maxLengthMetric = metricNames.reduce(
    (longest, metric) =>
      chartData[metric].length > chartData[longest].length ? metric : longest,
    metricNames[0]
  );

  return (
    <>
      <div>
        <Grid container spacing={2}>
          {metricNames
            .filter((metric) => chartData[metric].length !== 0)
            .map((metric: string) => (
              <Grid
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
                      show: !isCompare, // Hide labels in comparison mode
                      align: "left",
                      formatter: (r: any) => {
                        return r.value[1];
                      },
                    },
                  }}
                  legendPadding={320}
                />
              </Grid>
            ))}
        </Grid>
      </div>
      {modelName !== DEFAULT_MODEL_NAME && (
        <Box mt={4} px={2}>
          <Typography variant="h5" gutterBottom>
            {" "}
            Data details{" "}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            shows raw benchmark values along with metadata details for each
            entry.
          </Typography>
          <div>
            <MetricTable
              chartData={chartData}
              metricNames={metricNames}
              availableMetric={maxLengthMetric}
              METRIC_DISPLAY_SHORT_HEADERS={METRIC_DISPLAY_SHORT_HEADERS}
              WORKFLOW_ID_TO_COMMIT={WORKFLOW_ID_TO_COMMIT}
              repo={repoName}
            />
          </div>
        </Box>
      )}
    </>
  );
}

export const InfoTooltip = ({ title }: { title: string }) => (
  <Tooltip title={title} arrow placement="top">
    <IconButton size="small">
      <InfoOutlinedIcon fontSize="small" />
    </IconButton>
  </Tooltip>
);

const MetricCell = ({
  children,
  tooltipText = "",
}: {
  children: any;
  tooltipText: string;
}) => {
  return (
    <TableCell>
      {tooltipText === "" ? (
        children
      ) : (
        <>
          {children}
          <InfoTooltip title={tooltipText} />
        </>
      )}
    </TableCell>
  );
};

const MetricTable = ({
  chartData,
  metricNames,
  availableMetric,
  METRIC_DISPLAY_SHORT_HEADERS,
  WORKFLOW_ID_TO_COMMIT,
  repo,
}: {
  chartData: Record<string, any[]>;
  metricNames: string[];
  availableMetric: string;
  METRIC_DISPLAY_SHORT_HEADERS: Record<string, string>;
  WORKFLOW_ID_TO_COMMIT: Record<string, string>;
  repo: string;
}) => {
  const exportToCSV = () => {
    const baseData = chartData[availableMetric] ?? [];
    const rows = baseData.map((entry, index) => {
      const commit = WORKFLOW_ID_TO_COMMIT[entry.workflow_id];
      const row: Record<string, any> = {
        Date: entry?.metadata_info.timestamp,
        Commit: commit,
        Workflow: `${entry.workflow_id}/${entry.job_id}`,
      };

      metricNames.forEach((metric) => {
        if (chartData[metric]?.length) {
          const label = METRIC_DISPLAY_SHORT_HEADERS[metric] ?? metric;
          const matchingRecord = chartData[metric].find(
            (record: any) =>
              record.workflow_id === entry.workflow_id &&
              record.job_id === entry.job_id &&
              record.model === entry.model &&
              record.device === entry.device &&
              record.dtype === entry.dtype
          );
          row[label] =
            chartData[metric][index]?.actual ?? matchingRecord?.actual ?? "";
        }
      });
      return row;
    });

    const csvData = arrayToCSV(rows);
    const filename = generateCSVFilename("benchmark", "metrics", [
      repo.replace("/", "_"),
    ]);
    downloadCSV(csvData, filename);
  };
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        sx={{ mb: 1 }}
        onClick={exportToCSV}
      >
        Download as CSV
      </Button>
      <TableContainer
        component={Paper}
        sx={{ maxHeight: 440, margin: "10px 0", tableLayout: "auto" }}
      >
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <MetricCell tooltipText="the date when data inserted in db">
                Date
              </MetricCell>
              <MetricCell tooltipText="the latest commit associted with the git job">
                Commit
              </MetricCell>
              <MetricCell tooltipText="the workflow job that generates the value">
                Workflow Info
              </MetricCell>
              {metricNames.map((metric: string) => (
                <TableCell key={metric} sx={{ py: 0.5 }}>
                  {chartData[metric]?.length
                    ? METRIC_DISPLAY_SHORT_HEADERS[metric] ?? metric
                    : ""}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {chartData[availableMetric].map((entry: any, index: number) => {
              const commit = WORKFLOW_ID_TO_COMMIT[entry.workflow_id];
              // Get the source repository from the entry's extra field or use the default repo
              const sourceRepo = entry?.extra?.["source_repo"] || repo;
              const repoUrl = `https://github.com/${sourceRepo}`;
              return (
                <TableRow key={index}>
                  <TableCell>
                    <span>{entry?.metadata_info.timestamp} </span>
                  </TableCell>
                  <TableCell sx={{ py: 0.25 }}>
                    <code>
                      <Link
                        href={`${repoUrl}/commit/${commit}`}
                        target="_blank"
                        underline="hover"
                        sx={{ cursor: "pointer", fontSize: "0.75rem" }}
                      >
                        {commit}
                      </Link>
                    </code>
                  </TableCell>
                  <TableCell sx={{ py: 0.25 }}>
                    <Link
                      href={`${repoUrl}/actions/runs/${entry.workflow_id}/job/${entry.job_id}`}
                      target="_blank"
                    >
                      {entry.workflow_id}/{entry.job_id}
                    </Link>
                  </TableCell>
                  {metricNames
                    .filter((metric) => chartData[metric]?.length)
                    .map((metric) => {
                      const matchingRecord = chartData[metric].find(
                        (record: any) =>
                          record.workflow_id === entry.workflow_id &&
                          record.job_id === entry.job_id &&
                          record.model === entry.model &&
                          record.device === entry.device &&
                          record.dtype === entry.dtype
                      );
                      return (
                        <TableCell key={`${metric}-${index}`} sx={{ py: 0.25 }}>
                          {chartData[metric][index]?.actual ??
                            matchingRecord?.actual ??
                            ""}
                        </TableCell>
                      );
                    })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
};

function formGraphItem(data: any[]) {
  const res: any[] = [];
  data.forEach((item) => {
    const deviceId = item?.metadata_info?.device_id;
    const displayName = item.display;
    const repo =
      item?.repoTag ?? (item?.extra?.["source_repo"] as string | undefined);
    const repoPrefix = repo?.includes("sglang")
      ? "sglang / "
      : repo?.includes("vllm")
      ? "vllm / "
      : "";
    const group_key =
      deviceId && deviceId !== ""
        ? `${repoPrefix}${displayName} (${deviceId})`
        : `${repoPrefix}${displayName}`;
    res.push({ ...item, group_key });
  });
  return res;
}
