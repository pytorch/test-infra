import { Stack, Typography } from "@mui/material";
import { CommitPanel } from "components/benchmark/CommitPanel";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
import { useBenchmark } from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
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
    metricNames = [...TORCHAO_SPEEDUP_METRIC_NAMES, ...metricNames];
  }

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
      />
    </div>
  );
}
