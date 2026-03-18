import { Stack, Typography } from "@mui/material";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import { computeSpeedup } from "lib/benchmark/llms/utils/aoUtils";
import { useBenchmark } from "lib/benchmark/llms/utils/llmUtils";
import { BranchAndCommit } from "lib/types";
import LLMsGraphPanelBase from "./LLMsGraphPanelBase";

export default function LLMsGraphPanel({
  queryParams,
  granularity,
  repoName,
  benchmarkName,
  modelName,
  deviceName,
  metricNames,
  lBranchAndCommit,
  rBranchAndCommit,
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
}) {
  const { data } = useBenchmark(queryParams, {
    branch: rBranchAndCommit.branch,
    commit: "",
  });

  if (data === undefined || data.length === 0) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading chart for {modelName}...
        </Typography>
      </Stack>
    );
  }

  const dataWithSpeedup = computeSpeedup(
    repoName,
    computeSpeedup(repoName, data, false, true),
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
      isCompare={false}
    />
  );
}
