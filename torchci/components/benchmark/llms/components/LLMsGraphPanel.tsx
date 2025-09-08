import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Box,
  Button,
  Grid,
  IconButton,
  Link,
  Paper,
  Stack,
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
import { arrayToCSV, downloadCSV, generateCSVFilename } from "lib/csvUtils";

import {
  Granularity,
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import {
  DEFAULT_DEVICE_NAME,
  DEFAULT_MODEL_NAME,
  LLM_BENCHMARK_DATA_QUERY,
  LLMsBenchmarkData,
  METRIC_DISPLAY_HEADERS,
  METRIC_DISPLAY_SHORT_HEADERS,
} from "lib/benchmark/llms/common";
import {
  computeSpeedup,
  TORCHAO_SPEEDUP_METRIC_NAMES,
} from "lib/benchmark/llms/utils/aoUtils";
import {
  computeGeomean,
  fetchBenchmarkDataForRepos,
  getLLMsBenchmarkPropsQueryParameter,
  useBenchmark,
} from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
import { useEffect, useState } from "react";

const GRAPH_ROW_HEIGHT = 245;

export default function LLMsGraphPanel({
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
  repos,
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
  repos?: string[];
}) {
  const isCompare = !!(repos && repos.length > 1);
  const { data } = useBenchmark(queryParams, {
    branch: rBranchAndCommit.branch,
    commit: "",
  });

  const [datasets, setDatasets] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const startTimeParam = queryParams["startTime"];
  const stopTimeParam = queryParams["stopTime"];

  useEffect(() => {
    if (!isCompare || !repos) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    const repoQueryParams = repos.map((r) =>
      getLLMsBenchmarkPropsQueryParameter({
        repoName: r,
        benchmarkName,
        modelName,
        backendName,
        dtypeName,
        deviceName,
        startTime: dayjs(startTimeParam),
        stopTime: dayjs(stopTimeParam),
        timeRange: 0,
        granularity: granularity,
        lCommit: "",
        rCommit: "",
        lBranch: rBranchAndCommit.branch,
        rBranch: rBranchAndCommit.branch,
        repos: repos,
      } as any)
    );

    const repoParamsWithBranch = repoQueryParams.map((qp) => ({
      ...qp,
      branches: rBranchAndCommit.branch ? [rBranchAndCommit.branch] : [],
      commits: [],
    }));
    fetchBenchmarkDataForRepos(
      LLM_BENCHMARK_DATA_QUERY,
      repoParamsWithBranch
    ).then((res) => {
      if (!cancelled) {
        setDatasets(res.map((r) => r.data) as any[]);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    isCompare,
    repos,
    benchmarkName,
    modelName,
    backendName,
    dtypeName,
    deviceName,
    granularity,
    rBranchAndCommit.branch,
    startTimeParam,
    stopTimeParam,
  ]);

  // For comparison mode, fetch data for both repos; otherwise just one
  let dataWithSpeedup: any[] = [];
  if (isCompare) {
    if (
      loading ||
      datasets.length !== (repos ? repos.length : 0) ||
      datasets.some((d) => !d || d.length === 0)
    ) {
      return (
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"1rem"} fontStyle={"italic"}>
            Loading chart for {modelName}...
          </Typography>
        </Stack>
      );
    }

    const tagged = datasets.flatMap((d: any, i: number) =>
      d.map((rec: any) => ({
        ...rec,
        extra: { ...(rec.extra || {}), source_repo: repos![i] },
      }))
    );
    dataWithSpeedup = computeSpeedup(
      repoName,
      computeSpeedup(repoName, tagged, false, true),
      true,
      false
    );
  } else {
    if (data === undefined || data.length === 0) {
      return (
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"1rem"} fontStyle={"italic"}>
            Loading chart for {modelName}...
          </Typography>
        </Stack>
      );
    }

    dataWithSpeedup = computeSpeedup(
      repoName,
      computeSpeedup(repoName, data, false, true),
      true,
      false
    );
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from the database
  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

  // Only show records between these twos
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
    // group by timestamp to identify devices with the same timestamp
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
  });

  // find the metric with the longest data array, it is used as baseline for rows and mapping in the table.
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
                      show: true,
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
  const repoUrl = "https://github.com/" + repo;

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
          // Find the matching record for this metric based on workflow_id and other identifying properties
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
              return (
                <TableRow key={index}>
                  <TableCell>
                    <span>{entry?.metadata_info.timestamp} </span>
                  </TableCell>
                  <TableCell sx={{ py: 0.25 }}>
                    <code>
                      <Link
                        component="button"
                        underline="hover"
                        onClick={() => navigator.clipboard.writeText(commit)}
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
                      // Find the matching record for this metric based on workflow_id and other identifying properties
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

// creates chart items to visualize in the series graph, group by device name and display name
function formGraphItem(data: any[]) {
  const res: any[] = [];
  data.forEach((item) => {
    // Prefer minimal fields from geomean output; fall back to full objects for raw rows
    const deviceId = item?.metadata_info?.device_id;
    const displayName = item.display;
    const repo =
      item?.repoTag ?? (item?.extra?.["source_repo"] as string | undefined);
    // This is added to identify the difference between the two repos having same qps
    const repoPrefix = repo?.includes("sglang")
      ? "sglang / "
      : repo?.includes("vllm")
      ? "vllm / "
      : "";
    const group_key =
      deviceId && deviceId !== ""
        ? `${repoPrefix}${displayName} (${deviceId})`
        : `${repoPrefix}${displayName}`;
    // Use shallow copy to avoid heavy deep clone cost
    res.push({ ...item, group_key });
  });
  return res;
}
