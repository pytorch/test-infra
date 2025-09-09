import { Stack, Typography } from "@mui/material";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { LLM_BENCHMARK_DATA_QUERY } from "lib/benchmark/llms/common";
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
    d.map((rec: any) => ({
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
