
import {
  DEFAULT_DEVICE_NAME,
  DISPLAY_NAMES_TO_ARCH_NAMES,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
import { DEFAULT_MODE, MODES } from "components/benchmark/ModeAndDTypePicker";
import LoadingPage from "components/common/LoadingPage";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  useCompilerData,
} from "lib/benchmark/api_helper/compilers/type";
import {
  DashboardStoreProvider,
  useDashboardStore,
} from "lib/benchmark/store/benchmark_dashboard_provider";
import { SUITES } from "../compilers/SuitePicker";
import { Sidebar } from "./MainOptionSideBar";
import { CommitChoiceSection, REQUIRED_KEYS } from "./CommitChoiceSection";
dayjs.extend(utc);

export default function BenchmarkRegressionPage() {
  // Defaults for this benchmark
  const initial = {
    time: {
      start: dayjs.utc().startOf("day").subtract(7, "day"),
      end: dayjs.utc().endOf("day"),
    },
    filters: {
      mode: DEFAULT_MODE,
      dtype: MODES[DEFAULT_MODE],
      deviceName: DEFAULT_DEVICE_NAME,
      device: "cuda",
      arch: "h100",
    },
  };

  return (
    <DashboardStoreProvider key={'compiler_precompute'} initial={initial}>
      <div style={{ display: "flex" }}>
        <aside style={{ width: 320 }}>
          <Sidebar />
          <CommitChoiceSection />
        </aside>
        <main style={{ flex: 1 }}>
          <DataRender />
        </main>
      </div>
    </DashboardStoreProvider>
  );
}

function DataRender({ benchmarkId }: { benchmarkId?: string }) {
  const useStore = useDashboardStore();
  const committedTime = useStore((s) => s.committedTime);
  const committedFilters = useStore((s) => s.committedFilters);
  const lcommit = useStore((s) => s.lcommit);
  const rcommit = useStore((s) => s.rcommit);

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    REQUIRED_KEYS.every((k) => !!committedFilters[k]);

  const queryParams: any | null = ready
    ? {
        commits: [],
        branches: ["main"],
        compilers: [],
        arch: DISPLAY_NAMES_TO_ARCH_NAMES[committedFilters.deviceName],
        device: DISPLAY_NAMES_TO_DEVICE_NAMES[committedFilters.deviceName],
        dtype: committedFilters.dtype,
        granularity: "hour",
        mode: committedFilters.mode,
        startTime: dayjs.utc(committedTime.start).format("YYYY-MM-DDTHH:mm:ss"),
        stopTime: dayjs.utc(committedTime.end).format("YYYY-MM-DDTHH:mm:ss"),
        suites: Object.keys(SUITES),
      }
    : null;

  const { data, isLoading, error } = useCompilerData(
    "compiler_precompute",
    queryParams
  );
  if (isLoading) {
    return <LoadingPage />;
  }
  if (error) {
    return <div>Error: {error.message}</div>;
  }
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
