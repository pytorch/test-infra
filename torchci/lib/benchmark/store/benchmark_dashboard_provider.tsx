import { createContext, useContext, useRef } from "react";
import { StoreApi } from "zustand";
import { shallow } from "zustand/shallow";
import type { UseBoundStoreWithEqualityFn } from "zustand/traditional";
import type {
  BenchmarkCommitMeta,
  BenchmarkDashboardState,
  TimeRange,
} from "./benchmark_regression_store";
import { createDashboardStore } from "./benchmark_regression_store";
import { BenchmarkPageType } from "./benchmark_config_book";

// The context will hold a Zustand *hook* created by createDashboardStore.
// We wrap it in a React Context so different benchmark pages can each get their own store.
type DashboardStoreHook = UseBoundStoreWithEqualityFn<
  StoreApi<BenchmarkDashboardState>
>;
const DashboardContext = createContext<DashboardStoreHook | null>(null);

export function BenchmarkDashboardStoreProvider({
  children,
  initial,
  benchmarkId,
  type,
}: {
  children: React.ReactNode;
  benchmarkId: string;
  type: BenchmarkPageType;
  initial: {
    time: TimeRange;
    filters: Record<string, string>;
    lbranch: string;
    rbranch: string;
    lcommit?: BenchmarkCommitMeta;
    rcommit?: BenchmarkCommitMeta;
  };
}) {
  // useRef ensures the store is created only once per mount,
  // not on every re-render.
  const storeRef = useRef<DashboardStoreHook>();

  if (!storeRef.current) {
    const s = { ...initial, benchmarkId, type }
    // Create a new store using the provided initial values.
    // This happens once when the provider is mounted.
    storeRef.current = createDashboardStore(s);
  }

  return (
    // Provide the store to all children via React Context.
    // IMPORTANT: At the call site, wrap this Provider with `key={benchmarkId}`
    // so navigating to a new benchmarkId forces a remount and new store.
    <DashboardContext.Provider value={storeRef.current}>
      {children}
    </DashboardContext.Provider>
  );
}

// Hook to access the zustand store hook from context.
// Throws if no BenchmarkDashboardStoreProvider is found.
export function useDashboardStore(): DashboardStoreHook {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("DashboardStoreProvider is missing");
  return ctx;
}

// Convenience hook to select part of the dashboard state.
// This reduces re-renders compared to subscribing to the full store.
export function useDashboardSelector<T>(
  selector: (s: BenchmarkDashboardState) => T
): T {
  const useStore = useDashboardStore();
  return useStore(selector, shallow);
}
