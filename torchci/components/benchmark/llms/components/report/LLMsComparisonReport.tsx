import { Stack, Typography } from "@mui/material";
import {
  DEFAULT_MODEL_NAME,
  DEFAULT_QPS_NAME,
  LLM_BENCHMARK_DATA_QUERY,
} from "lib/benchmark/llms/common";
import { LLMsBenchmarkMode } from "lib/benchmark/llms/types/benchmarkMode";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
import {
  getLLMsBenchmarkPropsQueryParameter,
  useBenchmarkDataForRepos,
} from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
import _ from "lodash";
import { useMemo } from "react";
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

  const repoQueryParams = useMemo(
    () =>
      props.repos.map((repo) =>
        getLLMsBenchmarkPropsQueryParameter({
          ...props,
          repoName: repo,
          repos: [],
        })
      ),
    [
      props.repos,
      props.benchmarkName,
      props.modelName,
      props.backendName,
      props.dtypeName,
      props.deviceName,
      props.startTime,
      props.stopTime,
      props.granularity,
      props.qps,
      props.archName,
      props.modeName,
      props.repoName,
    ]
  );

  const lRepoParams = useMemo(
    () =>
      repoQueryParams.map((qp) => ({
        ...qp,
        branches: lBranchAndCommit.branch ? [lBranchAndCommit.branch] : [],
        commits: lBranchAndCommit.commit ? [lBranchAndCommit.commit] : [],
      })),
    [repoQueryParams, lBranchAndCommit.branch, lBranchAndCommit.commit]
  );
  const rRepoParams = useMemo(
    () =>
      repoQueryParams.map((qp) => ({
        ...qp,
        branches: rBranchAndCommit.branch ? [rBranchAndCommit.branch] : [],
        commits: rBranchAndCommit.commit ? [rBranchAndCommit.commit] : [],
      })),
    [repoQueryParams, rBranchAndCommit.branch, rBranchAndCommit.commit]
  );

  const { data: lRes } = useBenchmarkDataForRepos(
    LLM_BENCHMARK_DATA_QUERY,
    lRepoParams
  );
  const { data: rRes } = useBenchmarkDataForRepos(
    LLM_BENCHMARK_DATA_QUERY,
    rRepoParams
  );
  const lError = lRes?.find(
    (r: any): r is { error: any } => "error" in r
  )?.error;
  const rError = rRes?.find(
    (r: any): r is { error: any } => "error" in r
  )?.error;
  let lDatas = lRes?.map((r: any) => r.data) || [];
  let rDatas = rRes?.map((r: any) => r.data) || [];
  if (lRes && rRes && props.modelName === DEFAULT_MODEL_NAME) {
    const modelLists = [...lDatas, ...rDatas].map((d: any[]) =>
      _.uniq(
        d
          .map((rec: any) => rec.model)
          .filter((m: any) => m !== undefined && m !== null)
      )
    );
    const sharedModels = _.intersection(...modelLists);
    const filterToShared = (arrs: any[]) =>
      arrs.map((arr: any[]) =>
        arr.filter((rec: any) => sharedModels.includes(rec.model))
      );
    lDatas = filterToShared(lDatas);
    rDatas = filterToShared(rDatas);
  }

  if (
    lError ||
    rError ||
    !lRes ||
    !rRes ||
    lDatas.length !== props.repos.length ||
    rDatas.length !== props.repos.length ||
    lDatas.some((d: any) => !d || d.length === 0) ||
    rDatas.some((d: any) => !d || d.length === 0)
  ) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          {lError || rError
            ? `Failed to load comparison records for ${props.modelName}`
            : `Loading comparison records for ${props.modelName}...`}
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
      : arr.filter((rec: any) => String(rec.extra?.request_rate) === props.qps);

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
