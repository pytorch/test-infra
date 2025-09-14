import BenchmarkRegressionPage from "../../../BenchmarkRegressionPage";
import { BenchmarkUIConfigBook } from "../../../configs/configBook";

export default function CompilerBenchmarkPrecomputePage() {
  const config = BenchmarkUIConfigBook["compiler_precompute"];
  return (
    <BenchmarkRegressionPage
      benchmarkId={config.benchmarkId}
      initial={config.initial}
    />
  );
}
