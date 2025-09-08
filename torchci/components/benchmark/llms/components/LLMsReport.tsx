import { Stack, Typography } from "@mui/material";
import { CommitPanel } from "components/benchmark/CommitPanel";
import { LLM_BENCHMARK_DATA_QUERY } from "lib/benchmark/llms/common";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
import {
  fetchBenchmarkDataForRepos,
  getLLMsBenchmarkPropsQueryParameter,
  useBenchmark,
} from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
import { useEffect, useState } from "react";
import {
  computeSpeedup,
  TORCHAO_SPEEDUP_METRIC_NAMES,
} from "../../../../lib/benchmark/llms/utils/aoUtils";
import LLMsGraphPanel from "./LLMsGraphPanel";
import LLMsSummaryPanel from "./LLMsSummaryPanel";

export default function LLMsReport({
  props,
  metricNames,
  benchmarkPropsQueryParams,
}: {
  props: LLMsBenchmarkProps;
  metricNames: string[];
  benchmarkPropsQueryParams: any;
}) {
  const isCompare = props.repos && props.repos.length > 1;

  const { data: lData, error: _lError } = useBenchmark(
    benchmarkPropsQueryParams,
    {
      branch: props.lBranch,
      commit: props.lCommit,
    }
  );

  const lBranchAndCommit: BranchAndCommit = {
    branch: props.lBranch,
    commit: props.lCommit,
  };
  const rBranchAndCommit: BranchAndCommit = {
    branch: props.rBranch,
    commit: props.rCommit,
  };

  const { data: rData, error: _rError } = useBenchmark(
    benchmarkPropsQueryParams,
    rBranchAndCommit
  );

  if (isCompare) {
    return (
      <CompareLLMsReport
        props={props}
        metricNames={metricNames}
        benchmarkPropsQueryParams={benchmarkPropsQueryParams}
      />
    );
  }

  if (
    lData === undefined ||
    lData.length === 0 ||
    rData === undefined ||
    rData.length === 0
  ) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading records for {props.modelName}...
        </Typography>
      </Stack>
    );
  }

  const lDataWithSpeedup = computeSpeedup(
    props.repoName,
    computeSpeedup(props.repoName, lData, false, true),
    true,
    false
  );

  const rDataWithSpeedup = computeSpeedup(
    props.repoName,
    computeSpeedup(props.repoName, rData, false, true),
    true,
    false
  );

  if (props.repoName === "pytorch/ao") {
    if (!props.benchmarkName.startsWith("micro-benchmark")) {
      metricNames = [...TORCHAO_SPEEDUP_METRIC_NAMES, ...metricNames];
    }
  }

  // Single repo path below
  return (
    <div>
      <CommitPanel
        repoName={props.repoName}
        lBranchAndCommit={{
          ...rBranchAndCommit,
          date:
            rDataWithSpeedup !== undefined && rDataWithSpeedup.length !== 0
              ? rDataWithSpeedup[0].granularity_bucket
              : undefined,
        }}
        rBranchAndCommit={{
          ...lBranchAndCommit,
          date:
            lDataWithSpeedup !== undefined && lDataWithSpeedup.length !== 0
              ? lDataWithSpeedup[0].granularity_bucket
              : undefined,
        }}
        workflowName={""}
      >
        <></>
      </CommitPanel>
      <LLMsGraphPanel
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
          data: lDataWithSpeedup,
        }}
        rPerfData={{
          ...rBranchAndCommit,
          data: rDataWithSpeedup,
        }}
        repos={props.repos}
      />
    </div>
  );
}

function CompareLLMsReport({
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

  const lCombined = ([] as any[]).concat(
    ...lDatas.map((d: any, idx: number) =>
      computeSpeedup(
        props.repoName,
        tagWithRepo(d, props.repos[idx]),
        false,
        true
      )
    )
  );
  const rCombined = ([] as any[]).concat(
    ...rDatas.map((d: any, idx: number) =>
      computeSpeedup(
        props.repoName,
        tagWithRepo(d, props.repos[idx]),
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
      <LLMsGraphPanel
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
      />
    </div>
  );
}
