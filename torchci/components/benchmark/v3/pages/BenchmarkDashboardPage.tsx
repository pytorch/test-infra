import { Box } from "@mui/system";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { BenchmarkDashboardStoreProvider } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkSideBar from "../components/benchmarkSideBar/BenchmarkSideBar";
import { BenchmarkTopBar } from "../components/benchmarkSideBar/BenchmarkTopBar";
import { BenchmarkUIConfigHandler, useBenchmarkBook } from "lib/benchmark/store/benchmark_config_book";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import LoadingPage from "components/common/LoadingPage";
dayjs.extend(utc);

export default function BenchmarkDashboardPage({
  benchmarkId,
}: {
  benchmarkId: string;
}) {
const router = useRouter();
  const ensureConfig = useBenchmarkBook((s) => s.ensureConfig);
  const [config, setConfig] = useState<BenchmarkUIConfigHandler|undefined>()

  useEffect(() => {
    if (!router.isReady) return;
    const configHandler = ensureConfig(benchmarkId, "dashboard", {});
    setConfig(configHandler);
  }, [router.isReady, benchmarkId]);

  if (!config) return <LoadingPage />

  const Comp = config.getDataRenderComponent();
  return (
        <BenchmarkDashboardStoreProvider key={benchmarkId} initial={config.dataBinding.initialParams}>
          <Box style={{ display: "flex", minWidth: "800px", width: "100%" }}>
            <BenchmarkSideBar />
            <Box sx={{ width: "100%" }}>
              <BenchmarkTopBar config={config} />
              <Box style={{ flex: 1, minWidth: "600px", width: "100%" }}>
                <Comp />
              </Box>
            </Box>
          </Box>
        </BenchmarkDashboardStoreProvider>
  );
}
