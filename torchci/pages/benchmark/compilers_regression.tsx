import BenchmarkRegressionPage from "components/benchmark_v3/pages/BenchmarkRegressionPage";
import LoadingPage from "components/common/LoadingPage";
import {
  BenchmarkPageType,
  BenchmarkUIConfigHandler,
  useBenchmarkBook,
} from "lib/benchmark/store/benchmark_config_book";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

export default function Page() {
  const benchmarkId = "compiler_precompute";
  const type = BenchmarkPageType.AggregatePage;
  const router = useRouter();
  // ensure config will read the config from the store if it's predefined,
  // otherwise it will create a new config based on default template
  const ensureConfig = useBenchmarkBook((s) => s.ensureConfig);
  const [config, setConfig] = useState<BenchmarkUIConfigHandler | undefined>();

  useEffect(() => {
    if (!router.isReady) return;
    const configHandler = ensureConfig(benchmarkId, type, {});
    console.log("config", config, "type", type);

    setConfig(configHandler);
  }, [router.isReady, benchmarkId]);

  if (!config) return <LoadingPage />;

  const dataBinding = config.dataBinding;
  return (
    <BenchmarkRegressionPage
      benchmarkId={config.benchmarkId}
      type={type}
      initial={dataBinding.initialParams}
    />
  );
}
