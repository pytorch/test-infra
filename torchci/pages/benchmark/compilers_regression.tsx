import BenchmarkRegressionPage from "components/benchmark/v3/BenchmarkRegressionPage";
import { getConfig } from "components/benchmark/v3/configs/configBook";

export default function Page() {
  const id = "compiler_precompute";
  const config = getConfig(id);
  const dataBinding = config.dataBinding;
  return (
    <BenchmarkRegressionPage
      benchmarkId={config.benchmarkId}
      initial={dataBinding.initialParams}
    />
  );
}
