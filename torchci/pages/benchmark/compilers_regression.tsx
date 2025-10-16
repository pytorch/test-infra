import BenchmarkRegressionPage from "components/benchmark/v3/pages/BenchmarkRegressionPage";
import { useBenchmarkBook } from "lib/benchmark/store/benchmark_config_book";

export default function Page() {
  const id = "compiler_precompute";

  const getConfig = useBenchmarkBook((s) => s.getConfig);
  const config = getConfig(id);
  const dataBinding = config.dataBinding;
  return (
    <BenchmarkRegressionPage
      benchmarkId={config.benchmarkId}
      initial={dataBinding.initialParams}
    />
  );
}
