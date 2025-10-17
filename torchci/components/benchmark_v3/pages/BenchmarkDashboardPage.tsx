import { Box } from "@mui/system";
import LoadingPage from "components/common/LoadingPage";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  BenchmarkPageType,
  BenchmarkUIConfigHandler,
  useBenchmarkBook,
} from "lib/benchmark/store/benchmark_config_book";
import { BenchmarkDashboardStoreProvider } from "lib/benchmark/store/benchmark_dashboard_provider";
import { getBenchmarkIdMappingItem } from "lib/benchmark/store/benchmark_regression_store";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import BenchmarkSideBar from "../components/benchmarkSideBar/BenchmarkSideBar";
import { BenchmarkTopBar } from "../components/benchmarkSideBar/BenchmarkTopBar";
import { BenchmarkIdNotRegisterError } from "../components/common/BenchmarkIdNotRegisterError";
dayjs.extend(utc);

export default function BenchmarkDashboardPage({
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

  const mappingItem = getBenchmarkIdMappingItem(benchmarkId);
  if (!mappingItem) {
    return (
      <BenchmarkIdNotRegisterError
        benchmarkId={benchmarkId}
        content={"(BenchmarkDashboardPage)"}
      />
    );
  }

  const Comp = config.getDataRenderComponent();
  return (
    <BenchmarkDashboardStoreProvider
      key={`${type}||${benchmarkId}`}
      benchmarkId={benchmarkId}
      type={type}
      initial={config.dataBinding.initialParams}
    >
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
