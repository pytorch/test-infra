import { Stack, Typography } from "@mui/material";
import {
  COMMIT_TO_WORKFLOW_ID,
  WORKFLOW_ID_TO_COMMIT,
} from "components/benchmark/BranchAndCommitPicker";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import {
  DEFAULT_QPS_NAME,
  LLM_BENCHMARK_BRANCHES_QUERY,
  LLM_BENCHMARK_DATA_QUERY,
} from "lib/benchmark/llms/common";
import { computeSpeedup } from "lib/benchmark/llms/utils/aoUtils";
import {
  getLLMsBenchmarkPropsQueryParameter,
  useBenchmarkDataForRepos,
} from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
import { useEffect, useMemo } from "react";
import LLMsGraphPanelBase from "./LLMsGraphPanelBase";

export default function LLMsComparisonGraphPanel({
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
  qps,
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
  repos: string[];
  qps: string;
}) {
  const startTimeParam = queryParams["startTime"];
  const stopTimeParam = queryParams["stopTime"];

  const repoQueryParams = useMemo(
    () =>
      repos.map((r) =>
        getLLMsBenchmarkPropsQueryParameter({
          repoName: r,
          benchmarkName,
          modelName,
          backendName,
          dtypeName,
          deviceName,
          qps,
          startTime: dayjs(startTimeParam),
          stopTime: dayjs(stopTimeParam),
          timeRange: 0,
          granularity: granularity,
          lCommit: "",
          rCommit: "",
          lBranch: rBranchAndCommit.branch,
          rBranch: rBranchAndCommit.branch,
          repos: [],
        } as any)
      ),
    [
      repos,
      benchmarkName,
      modelName,
      backendName,
      dtypeName,
      deviceName,
      qps,
      startTimeParam,
      stopTimeParam,
      granularity,
      rBranchAndCommit.branch,
    ]
  );

  const repoParamsWithBranch = useMemo(
    () =>
      repoQueryParams.map((qp) => ({
        ...qp,
        branches: rBranchAndCommit.branch ? [rBranchAndCommit.branch] : [],
        commits: [],
      })),
    [repoQueryParams, rBranchAndCommit.branch]
  );

  const { data: datasetResults } = useBenchmarkDataForRepos(
    LLM_BENCHMARK_DATA_QUERY,
    repoParamsWithBranch
  );
  const { data: commitResults } = useBenchmarkDataForRepos(
    LLM_BENCHMARK_BRANCHES_QUERY,
    repoQueryParams
  );

  const datasets = datasetResults?.map((r: any) => r.data);
  const dataError = datasetResults?.find(
    (r: any): r is { error: any } => "error" in r
  )?.error;
  const commitData = commitResults?.map((r: any) => r.data);
  const commitError = commitResults?.find(
    (r: any): r is { error: any } => "error" in r
  )?.error;

  useEffect(() => {
    if (!commitData) {
      return;
    }
    commitData.forEach((res: any) =>
      res?.forEach((r: any) => {
        COMMIT_TO_WORKFLOW_ID[r.head_sha] = r.id;
        WORKFLOW_ID_TO_COMMIT[r.id] = r.head_sha;
      })
    );
  }, [commitData]);

  if (
    dataError ||
    commitError ||
    !datasets ||
    datasets.length !== repos.length ||
    datasets.some((d) => !d || d.length === 0)
  ) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          {dataError || commitError
            ? `Failed to load chart for ${modelName}...`
            : `Loading chart for ${modelName}...`}
        </Typography>
      </Stack>
    );
  }

  const tagged = datasets.flatMap((d: any, i: number) =>
    d
      .filter(
        (rec: any) =>
          qps === DEFAULT_QPS_NAME || String(rec.extra?.request_rate) === qps
      )
      .map((rec: any) => ({
        ...rec,
        extra: { ...(rec.extra || {}), source_repo: repos[i] },
      }))
  );
  const dataWithSpeedup = computeSpeedup(
    repoName,
    computeSpeedup(repoName, tagged, false, true),
    true,
    false
  );

  return (
    <LLMsGraphPanelBase
      queryParams={queryParams}
      granularity={granularity}
      repoName={repoName}
      benchmarkName={benchmarkName}
      modelName={modelName}
      deviceName={deviceName}
      metricNames={metricNames}
      lBranchAndCommit={lBranchAndCommit}
      rBranchAndCommit={rBranchAndCommit}
      dataWithSpeedup={dataWithSpeedup}
      isCompare={true}
    />
  );
}
