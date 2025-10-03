import { getConfig } from "components/benchmark/v3/configs/configBook";
import BenchmarkRegressionPage from "components/benchmark/v3/pages/BenchmarkRegressionPage";

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
