import { Alert } from "@mui/material";
import { Box } from "@mui/system";
import LoadingPage from "components/common/LoadingPage";
import {
  useBenchmarkConfigBook,
  useListBenchmarkMetadata,
} from "lib/benchmark/api_helper/fe/hooks";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkDropdownGroup from "./BenchmarkFilterDropdownGroup";

export default function DefaultMetricsDropdowns() {
  const {
    setStagedFilter,
    repo,
    type,
    benchmarkId,
    benchmarkName,
    stagedTime,
    stagedFilters,
  } = useDashboardSelector((s) => ({
    setStagedFilter: s.setStagedFilter,
    repo: s.repo,
    type: s.type,
    benchmarkName: s.benchmarkName,
    benchmarkId: s.benchmarkId,
    stagedTime: s.stagedTime,
    stagedFilters: s.stagedFilters,
  }));

  const configHandler = useBenchmarkConfigBook(benchmarkId, type);
  const ready = !!configHandler && !!stagedTime?.start && !!stagedTime?.end;

  // convert to the query params
  const queryParams = ready
    ? configHandler.dataBinding.toQueryParams({
        repo: repo,
        benchmarkName: benchmarkName,
        timeRange: stagedTime,
        filters: {}, // the dropdown does not rerender when filter changes, since it manages the filter optons
      })
    : null;

  const {
    data: resp,
    isLoading: isLoading,
    error: error,
  } = useListBenchmarkMetadata(benchmarkId, queryParams);

  if (isLoading) {
    return <LoadingPage />;
  }

  if (error) {
    return (
      <Alert severity="error"> DefaultMetricsDropdowns {error.message}</Alert>
    );
  }

  const metadataList = resp?.data || [];

  return (
    <Box>
      <BenchmarkDropdownGroup
        optionListMap={metadataList}
        onChange={(_key: string, _value: any) => {
          if (_key == "deviceName") {
            handleDeviceName(_value, setStagedFilter);
          }
          setStagedFilter(_key, _value);
        }}
        props={stagedFilters}
      />
    </Box>
  );
}

function handleDeviceName(
  deviceName: string,
  setFilter: (k: string, v: string) => void
) {
  if (deviceName == "") {
    setFilter("device", "");
    setFilter("arch", "");
    return;
  }

  const v = deviceName.split("||");

  if (v.length === 2) {
    setFilter("device", v[0]);
    setFilter("arch", v[1]);
  } else {
    setFilter("device", deviceName);
    setFilter("arch", "");
  }
}
