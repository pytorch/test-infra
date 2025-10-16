import { useBenchmarkCommittedContext, useBenchmarkTimeSeriesData } from "lib/benchmark/api_helper/fe/hooks";
import LoadingPage from "components/common/LoadingPage";
import { Alert } from "@mui/material";
import { useBenchmarkBook } from "lib/benchmark/store/benchmark_config_book";
import { RenderRawContent } from "../../common/RawContentDialog";

export function AutoBenchmarkPairwiseComparisonTable() {
  const ctx = useBenchmarkCommittedContext();

  if(!ctx){
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
  const config = getConfig(ctx.benchmarkId);
  const dataBinding = config.dataBinding;

  // convert to the query params
  const params = dataBinding.toQueryParams({
    repo: ctx.repo,
    branches:branches,
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
    return <Alert severity="error">(AutoBenchmarkPairwiseComparisonTable){error.message}</Alert>;
  }
  if (!ctx.dataRender?.renders) {
    return <div>no data render</div>;
  }
  if (!resp?.data?.data) {
    return <div>no data</div>;
  }

  const data = resp?.data?.data
  return (
    <div>
      <RenderRawContent data={queryParams} type="json" title="tawta" buttonName="queryParams"/>
      <RenderRawContent data={data} type="json" title="tawta" buttonName="queryParams"/>
    </div>
  );
}
