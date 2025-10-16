import LoadingPage from "components/common/LoadingPage";
import { useBenchmarkConfigBook, useListBenchmarkMetadata } from "lib/benchmark/api_helper/fe/hooks";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { RenderRawContent } from "../../../common/RawContentDialog";
import { Box } from "@mui/system";
import BenchmarkDropdownGroup from "./BenchmarkFilterDropdownGroup";
import { Alert } from "@mui/material";

export default function DefaultMetricsDropdowns() {
  const {
      setStagedFilter,
      repo,
      benchmarkId,
      benchmarkName,
      stagedTime,
      stagedFilters
    } = useDashboardSelector((s) => ({
      setStagedFilter: s.setStagedFilter,
      repo: s.repo,
      benchmarkName: s.benchmarkName,
      benchmarkId: s.benchmarkId,
      stagedTime: s.stagedTime,
      stagedFilters: s.stagedFilters,
    }));

  const configHandler = useBenchmarkConfigBook(benchmarkId)
  if (!configHandler) {
    return  <LoadingPage />
  }

  const ready =!!stagedTime?.start && !!stagedTime?.end
  // convert to the query params
  const params = configHandler.dataBinding.toQueryParams({
    repo: repo,
    benchmarkName: benchmarkName,
    timeRange: stagedTime,
    filters: {},
  });

  const queryParams: any | null = ready ? params : null;
  // fetch the bechmark data

  const {
    data: resp,
    isLoading: isLoading,
    error: error,
  } = useListBenchmarkMetadata(benchmarkId, queryParams);

  if (isLoading) {
    return <LoadingPage />;
  }

  if (error) {
    return <Alert severity="error"> DefaultMetricsDropdowns {error.message}</Alert>
  }

  const metadataList = resp?.data || [];

  return <Box>
    <RenderRawContent data={resp} type="json" title="tawta" buttonName="result"/>
    <BenchmarkDropdownGroup optionListMap={metadataList} onChange={(_key:string, _value:any)=> {
      if (_key == "deviceName"){
        const v = _value.split("||");
        if (v.length === 2) {
          setStagedFilter("device", v[0]);
          setStagedFilter("arch", v[1]);
        }
      }
      setStagedFilter(_key, _value);
    }} props={stagedFilters} />
    </Box>
}
