import { BenchmarkUIConfigBook } from "components/benchmark/v3/configs/configBook";
import LoadingPage from "components/common/LoadingPage";
import { useBenchmarkData } from "lib/benchmark/api_helper/compilers/type";
import { useDashboardStore } from "lib/benchmark/store/benchmark_dashboard_provider";
import { getGetQueryParamsConverter } from "../../configs/configRegistration";

export function DefaultRenderContent() {
  const useStore = useDashboardStore();
  const committedTime = useStore((s) => s.committedTime);
  const committedFilters = useStore((s) => s.committedFilters);
  const committedLBranch = useStore((s) => s.committedLbranch);
  const committedRBranch = useStore((s) => s.committedRbranch);

  const benchmarkId = useStore((s) => s.benchmarkId);
  const config = BenchmarkUIConfigBook[benchmarkId];

  const requiredFilters = config?.required_filter_fields ?? [];

  const branches = [
    ...new Set(
      [committedLBranch, committedRBranch].filter((b) => b.length > 0)
    ),
  ];

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    !!committedLBranch &&
    !!committedRBranch &&
    requiredFilters.every((k) => !!committedFilters[k]);

  const converter = getGetQueryParamsConverter(config);

  const params = converter(committedTime, branches, [], committedFilters);
  const queryParams: any | null = ready ? params : null;

  const { data, isLoading, error } = useBenchmarkData(benchmarkId, queryParams);
  if (isLoading) {
    return <LoadingPage />;
  }
  if (error) {
    return <div>Error: {error.message}</div>;
  }
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
