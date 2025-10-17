import { Alert } from "@mui/material";
import { Box, Grid } from "@mui/system";
import { AutoComponentProps } from "components/benchmark_v3/configs/utils/autoRegistration";
import LoadingPage from "components/common/LoadingPage";
import {
  useBenchmarkCommittedContext,
  useBenchmarkTimeSeriesData,
} from "lib/benchmark/api_helper/fe/hooks";
import {
  UIRenderConfig,
  useBenchmarkBook,
} from "lib/benchmark/store/benchmark_config_book";
import { ComparisonTable } from "../components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTable/ComparisonTable";

export function AutoBenchmarkPairwiseComparisonTable({
  config,
}: AutoComponentProps) {
  const ctx = useBenchmarkCommittedContext();

  const uiRenderConfig = config as UIRenderConfig;

  if (!ctx) {
    return <LoadingPage />;
  }

  const branches = [
    ...new Set(
      [ctx.committedLbranch, ctx.committedRbranch].filter((b) => b.length > 0)
    ),
  ];

  const ready =
    !!ctx.committedTime?.start &&
    !!ctx.committedTime?.end &&
    !!ctx.committedLbranch &&
    !!ctx.committedRbranch &&
    ctx.requiredFilters.every((k: string) => !!ctx.committedFilters[k]);

  const getConfig = useBenchmarkBook((s) => s.getConfig);
  const c = getConfig(ctx.benchmarkId);
  const dataBinding = c.dataBinding;

  // convert to the query params
  const params = dataBinding.toQueryParams({
    repo: ctx.repo,
    branches: branches,
    benchmarkName: ctx.benchmarkName,
    timeRange: ctx.committedTime,
    filters: ctx.committedFilters,
    maxSampling: ctx.committedMaxSampling,
  });

  const queryParams: any | null = ready ? params : null;
  // fetch the bechmark data
  const {
    data: resp,
    isLoading,
    error,
  } = useBenchmarkTimeSeriesData(ctx.benchmarkId, queryParams, ["table"]);

  if (isLoading) {
    return <LoadingPage />;
  }

  if (error) {
    return (
      <Alert severity="error">
        (AutoBenchmarkPairwiseComparisonTable){error.message}
      </Alert>
    );
  }
  if (!ctx.dataRender?.renders) {
    return <div>no data render</div>;
  }
  if (!resp?.data?.data) {
    return <div>no data</div>;
  }
  const data = resp?.data?.data;
  return (
      <Grid container sx={{ m: 1 }}>
        <Grid size={{ xs: 12}}>
        <ComparisonTable
        data={data["table"]}
        config={uiRenderConfig.config}
        lWorkflowId={ctx.lcommit?.workflow_id ?? null}
        rWorkflowId={ctx.rcommit?.workflow_id ?? null}
        title={{
          text: "Comparison Table",
        }}
        onSelect={() => {}}
      />
      </Grid>
      </Grid>
  );
}
