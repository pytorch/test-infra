import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { BenchmarkDashboardStoreProvider } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkSideBar from "./components/benchmarkSideBar/BenchmarkSideBar";
import { BenchmarkUIConfigBook } from "./configs/configBook";
import { getDataRenderComponent } from "./configs/configRegistration";
dayjs.extend(utc);

export default function BenchmarkRegressionPage({
  benchmarkId,
  initial,
}: {
  benchmarkId: string;
  initial: any;
}) {
  const config = BenchmarkUIConfigBook[benchmarkId];

  // get dynamic componenet if any registered, otherwise use default
  const Comp = getDataRenderComponent(config);

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
