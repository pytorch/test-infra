import { createContext, useContext, useMemo } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import type {
  BenchmarkCommitMeta,
  BenchmarkDashboardState,
  TimeRange,
} from "./benchmark_regression_store";
import { createDashboardStore } from "./benchmark_regression_store";

// The context holds the Zustand *hook* returned by createDashboardStore
type DashboardStoreHook = UseBoundStore<StoreApi<BenchmarkDashboardState>>;
const DashboardContext = createContext<DashboardStoreHook | null>(null);

export function BenchmarkDashboardStoreProvider({
  children,
  initial,
}: {
  children: React.ReactNode;
  initial: {
    benchmarkId: string;
    time: TimeRange;
    filters: Record<string, string>;
    lbranch: string;
    rbranch: string;
    lcommit?: BenchmarkCommitMeta;
    rcommit?: BenchmarkCommitMeta;
  };
}) {
  const store = useMemo(
    () => createDashboardStore(initial),
    [initial.time, initial.filters]
  );
  return (
    <DashboardContext.Provider value={store}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboardStore(): DashboardStoreHook {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("DashboardStoreProvider missing");
  return ctx;
}

export function useDashboardSelector<T>(
  selector: (s: BenchmarkDashboardState) => T
): T {
  const useStore = useDashboardStore();
  return useStore(selector);
}
