import BenchmarkRegressionPage from "components/benchmark/v3/BenchmarkRegressionPage";
import { BenchmarkUIConfigBook } from "components/benchmark/v3/configs/configBook";

export default function Page() {
  const config = BenchmarkUIConfigBook["compiler_precompute"];
  return (
    <BenchmarkRegressionPage
      benchmarkId={config.benchmarkId}
      initial={config.initial}
    />
  );
}
