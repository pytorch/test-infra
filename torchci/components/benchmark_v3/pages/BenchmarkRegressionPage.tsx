import { Box } from "@mui/system";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  BenchmarkPageType,
  useBenchmarkBook,
} from "lib/benchmark/store/benchmark_config_book";
import { BenchmarkDashboardStoreProvider } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkSideBar from "../components/benchmarkSideBar/BenchmarkSideBar";
import { BenchmarkTopBar } from "../components/benchmarkSideBar/BenchmarkTopBar";
dayjs.extend(utc);

export default function BenchmarkRegressionPage({
  benchmarkId,
  type,
  initial,
}: {
  benchmarkId: string;
  type: BenchmarkPageType;
  initial: any;
}) {
  const getConfig = useBenchmarkBook((s) => s.getConfig);
  const config = getConfig(benchmarkId, type);

  // get dynamic componenet if any registered, otherwise use default
  const Comp = config.getDataRenderComponent();

  return (
      <BenchmarkDashboardStoreProvider
      key={`${type}||${benchmarkId}`}
      benchmarkId={benchmarkId}
      type={type}
      initial={initial}
    >
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
