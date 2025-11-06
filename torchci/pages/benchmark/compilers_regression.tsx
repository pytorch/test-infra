import { BenchmarkPageType } from "components/benchmark_v3/configs/benchmark_config_book";
import BenchmarkRegressionPage from "components/benchmark_v3/pages/BenchmarkRegressionPage";

export default function Page() {
  const benchmarkId = "compiler_precompute";
  const type = BenchmarkPageType.AggregatePage;

  return <BenchmarkRegressionPage benchmarkId={benchmarkId} type={type} />;
}
