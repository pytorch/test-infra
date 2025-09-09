import { Stack, Typography } from "@mui/material";
import {
  DEFAULT_QPS_NAME,
  LLM_BENCHMARK_DATA_QUERY,
} from "lib/benchmark/llms/common";
import { LLMsBenchmarkMode } from "lib/benchmark/llms/types/benchmarkMode";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
import {
  fetchBenchmarkDataForRepos,
  getLLMsBenchmarkPropsQueryParameter,
} from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
import { useEffect, useState } from "react";
import { computeSpeedup } from "../../../../../lib/benchmark/llms/utils/aoUtils";
import LLMsComparisonGraphPanel from "../graphPanel/LLMsComparisonGraphPanel";
import LLMsSummaryPanel from "../LLMsSummaryPanel";

export default function LLMsComparisonReport({
  props,
  metricNames,
  benchmarkPropsQueryParams,
}: {
  props: LLMsBenchmarkProps;
  metricNames: string[];
  benchmarkPropsQueryParams: any;
}) {
  const lBranchAndCommit: BranchAndCommit = {
    branch: props.lBranch,
    commit: props.lCommit,
  };
  const rBranchAndCommit: BranchAndCommit = {
    branch: props.rBranch,
    commit: props.rCommit,
  };

  const [lDatas, setLDatas] = useState<any[]>([]);
  const [rDatas, setRDatas] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const repoQueryParams = props.repos.map((repo) =>
      getLLMsBenchmarkPropsQueryParameter({ ...props, repoName: repo })
    );

    const fetchFor = (branchAndCommit: BranchAndCommit) => {
      const repoParams = repoQueryParams.map((qp) => ({
        ...qp,
        branches: branchAndCommit.branch ? [branchAndCommit.branch] : [],
        commits: branchAndCommit.commit ? [branchAndCommit.commit] : [],
      }));
      return fetchBenchmarkDataForRepos(
        LLM_BENCHMARK_DATA_QUERY,
        repoParams
      ).then((res) => res.map((r) => r.data));
    };

    Promise.all([fetchFor(lBranchAndCommit), fetchFor(rBranchAndCommit)]).then(
      ([lRes, rRes]) => {
        if (!cancelled) {
          setLDatas(lRes as any[]);
          setRDatas(rRes as any[]);
          setLoading(false);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [
    props.repos,
    props.lBranch,
    props.lCommit,
    props.rBranch,
    props.rCommit,
    props.benchmarkName,
    props.modelName,
    props.backendName,
    props.dtypeName,
    props.deviceName,
    props.startTime,
    props.stopTime,
    props.granularity,
  ]);

  if (
    loading ||
    lDatas.length !== props.repos.length ||
    rDatas.length !== props.repos.length ||
    lDatas.some((d: any) => !d || d.length === 0) ||
    rDatas.some((d: any) => !d || d.length === 0)
  ) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading comparison records for {props.modelName}...
        </Typography>
      </Stack>
    );
  }

  const tagWithRepo = (arr: any[], repo: string) =>
    arr.map((rec: any) => ({
      ...rec,
      extra: { ...(rec.extra || {}), source_repo: repo },
    }));

  const filterByQps = (arr: any[]) =>
    props.qps === DEFAULT_QPS_NAME
      ? arr
      : arr.filter((rec: any) => rec.extra?.request_rate === props.qps);

  const lCombined = ([] as any[]).concat(
    ...lDatas.map((d: any, idx: number) =>
      computeSpeedup(
        props.repoName,
        tagWithRepo(filterByQps(d), props.repos[idx]),
        false,
        true
      )
    )
  );
  const rCombined = ([] as any[]).concat(
    ...rDatas.map((d: any, idx: number) =>
      computeSpeedup(
        props.repoName,
        tagWithRepo(filterByQps(d), props.repos[idx]),
        false,
        true
      )
    )
  );

  const lDataWithSpeedupCombined = computeSpeedup(
    props.repoName,
    lCombined,
    true,
    false
  );
  const rDataWithSpeedupCombined = computeSpeedup(
    props.repoName,
    rCombined,
    true,
    false
  );

  return (
    <div>
      <LLMsComparisonGraphPanel
        queryParams={benchmarkPropsQueryParams}
        granularity={props.granularity}
        repoName={props.repoName}
        benchmarkName={props.benchmarkName}
        modelName={props.modelName}
        backendName={props.backendName}
        dtypeName={props.dtypeName}
        deviceName={props.deviceName}
        metricNames={metricNames}
        lBranchAndCommit={lBranchAndCommit}
        rBranchAndCommit={rBranchAndCommit}
        repos={props.repos}
        qps={props.qps}
      />
      <LLMsSummaryPanel
        startTime={props.startTime}
        stopTime={props.stopTime}
        granularity={props.granularity}
        repoName={props.repoName}
        benchmarkName={props.benchmarkName}
        modelName={props.modelName}
        backendName={props.backendName}
        metricNames={metricNames}
        archName={props.archName}
        lPerfData={{
          ...lBranchAndCommit,
          data: lDataWithSpeedupCombined,
        }}
        rPerfData={{
          ...rBranchAndCommit,
          data: rDataWithSpeedupCombined,
        }}
        repos={props.repos}
        mode={LLMsBenchmarkMode.RepoComparison}
      />
    </div>
  );
}
