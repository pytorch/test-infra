import BenchmarkRegressionPage from "components/benchmark_v3/pages/BenchmarkRegressionPage";
import { BenchmarkPageType } from "lib/benchmark/store/benchmark_config_book";

export default function Page() {
  const benchmarkId = "compiler_precompute";
  const type = BenchmarkPageType.AggregatePage;

  return <BenchmarkRegressionPage benchmarkId={benchmarkId} type={type} />;
}
