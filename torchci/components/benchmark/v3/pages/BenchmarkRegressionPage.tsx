import { Box } from "@mui/system";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { BenchmarkDashboardStoreProvider } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkSideBar from "../components/benchmarkSideBar/BenchmarkSideBar";
import { BenchmarkTopBar } from "../components/benchmarkSideBar/BenchmarkTopBar";
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
      <Box style={{ display: "flex", minWidth: "800px", width: "100%" }}>
        <BenchmarkSideBar />
        <Box sx={{ width: "100%" }}>
          {/* horizontal bar */}
          <BenchmarkTopBar config={config} />
          {/* scrollable content */}
          <Box style={{ flex: 1, minWidth: "600px", width: "100%" }}>
            <Comp />
          </Box>
        </Box>
      </Box>
    </BenchmarkDashboardStoreProvider>
  );
}
