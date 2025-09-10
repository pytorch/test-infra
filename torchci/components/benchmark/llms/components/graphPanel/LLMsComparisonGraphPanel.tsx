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
  fetchBenchmarkDataForRepos,
  getLLMsBenchmarkPropsQueryParameter,
} from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
import { useEffect, useState } from "react";
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
  const [datasets, setDatasets] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const startTimeParam = queryParams["startTime"];
  const stopTimeParam = queryParams["stopTime"];

  useEffect(() => {
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
    );

    const repoParamsWithBranch = repoQueryParams.map((qp) => ({
      ...qp,
      branches: rBranchAndCommit.branch ? [rBranchAndCommit.branch] : [],
      commits: [],
    }));
    Promise.all([
      fetchBenchmarkDataForRepos(
        LLM_BENCHMARK_DATA_QUERY,
        repoParamsWithBranch
      ),
      fetchBenchmarkDataForRepos(LLM_BENCHMARK_BRANCHES_QUERY, repoQueryParams),
    ]).then(([dataRes, commitRes]) => {
      if (!cancelled) {
        setDatasets(dataRes.map((r) => r.data) as any[]);
        commitRes.forEach((res) =>
          res.data?.forEach((r: any) => {
            COMMIT_TO_WORKFLOW_ID[r.head_sha] = r.id;
            WORKFLOW_ID_TO_COMMIT[r.id] = r.head_sha;
          })
        );
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
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
    qps,
  ]);

  if (
    loading ||
    datasets.length !== repos.length ||
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
