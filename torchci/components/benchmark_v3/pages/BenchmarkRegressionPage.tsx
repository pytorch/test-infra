import { Box } from "@mui/system";
import {
  BenchmarkPageType,
  BenchmarkUIConfigHandler,
  useBenchmarkBook,
} from "components/benchmark_v3/configs/benchmark_config_book";
import LoadingPage from "components/common/LoadingPage";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { BenchmarkDashboardStoreProvider } from "lib/benchmark/store/benchmark_dashboard_provider";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import BenchmarkSideBar from "../components/benchmarkSideBar/BenchmarkSideBar";
import { BenchmarkTopBar } from "../components/benchmarkSideBar/BenchmarkTopBar";
dayjs.extend(utc);

export default function BenchmarkRegressionPage({
  benchmarkId,
  type,
}: {
  benchmarkId: string;
  type: BenchmarkPageType;
}) {
  const router = useRouter();
  // ensure config will read the config from the store if it's predefined,
  // otherwise it will create a new config based on default template
  const ensureConfig = useBenchmarkBook((s) => s.ensureConfig);
  const [config, setConfig] = useState<BenchmarkUIConfigHandler | undefined>();
  useEffect(() => {
    if (!router.isReady) return;
    const configHandler = ensureConfig(benchmarkId, type, {});
    setConfig(configHandler);
  }, [router.isReady, benchmarkId]);
  if (!config) return <LoadingPage />;

  // get dynamic componenet if any registered, otherwise use default
  const Comp = config.getDataRenderComponent();
  const initial = config.dataBinding.initialParams;

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
