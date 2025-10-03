import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { BenchmarkDashboardStoreProvider } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkSideBar from "../components/benchmarkSideBar/BenchmarkSideBar";
import { getConfig } from "../configs/configBook";
dayjs.extend(utc);

export default function BenchmarkRegressionPage({
  benchmarkId,
  initial,
}: {
  benchmarkId: string;
  initial: any;
}) {
  const config = getConfig(benchmarkId);

  // get dynamic componenet if any registered, otherwise use default
  const Comp = config.getDataRenderComponent();

  return (
    <BenchmarkDashboardStoreProvider key={benchmarkId} initial={initial}>
      <div style={{ display: "flex" }}>
        <BenchmarkSideBar />
        <main style={{ flex: 1 }}>
          <Comp />
        </main>
      </div>
    </BenchmarkDashboardStoreProvider>
  );
}
