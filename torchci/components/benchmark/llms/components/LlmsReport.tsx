import { Stack, Typography } from "@mui/material";
import { CommitPanel } from "components/benchmark/CommitPanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { BranchAndCommit } from "lib/types";
import { computeSpeedup, TORCHAO_SPEEDUP_METRIC_NAMES } from "../lib/aoUtils";
import { useBenchmark } from "../lib/llmUtils";
import { LlmsGraphPanel } from "./LlmsGraphPanel";
import { LlmsSummaryPanel } from "./LlmsSummaryPanel";

export default function LlmsReport({
  queryParams,
  startTime,
  stopTime,
  granularity,
  repoName,
  benchmarkName,
  modelName,
  backendName,
  modeName,
  dtypeName,
  deviceName,
  archName,
  metricNames,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: { [key: string]: any };
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  repoName: string;
  benchmarkName: string;
  modelName: string;
  backendName: string;
  modeName: string;
  dtypeName: string;
  deviceName: string;
  archName: string;
  metricNames: string[];
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  const { data: lData, error: _lError } = useBenchmark(
    queryParams,
    lBranchAndCommit
  );
  const { data: rData, error: _rError } = useBenchmark(
    queryParams,
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
          Loading records for {modelName}...
        </Typography>
      </Stack>
    );
  }

  const lDataWithSpeedup = computeSpeedup(
    repoName,
    computeSpeedup(repoName, lData, false, true),
    true,
    false
  );

  const rDataWithSpeedup = computeSpeedup(
    repoName,
    computeSpeedup(repoName, rData, false, true),
    true,
    false
  );

  if (repoName === "pytorch/ao") {
    metricNames = [...TORCHAO_SPEEDUP_METRIC_NAMES, ...metricNames];
  }

  return (
    <div>
      <CommitPanel
        repoName={repoName}
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
      <LlmsGraphPanel
        queryParams={queryParams}
        granularity={granularity}
        repoName={repoName}
        benchmarkName={benchmarkName}
        modelName={modelName}
        backendName={backendName}
        dtypeName={dtypeName}
        deviceName={deviceName}
        metricNames={metricNames}
        lBranchAndCommit={lBranchAndCommit}
        rBranchAndCommit={rBranchAndCommit}
      />
      <LlmsSummaryPanel
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        repoName={repoName}
        benchmarkName={benchmarkName}
        modelName={modelName}
        backendName={backendName}
        metricNames={metricNames}
        archName={archName}
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
