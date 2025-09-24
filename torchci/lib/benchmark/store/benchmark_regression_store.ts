// benchmark_regression_store.ts
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { createWithEqualityFn } from "zustand/traditional";

export type TimeRange = { start: Dayjs; end: Dayjs };
type KV = Record<string, string | null>;

export type BenchmarkCommitMeta = {
  commit: string;
  date: string;
  branch: string;
  workflow_id: string;
  index?: number;
};

export interface BenchmarkDashboardState {
  stagedTime: TimeRange;
  stagedFilters: Record<string, string>;
  stagedLbranch: string;
  stagedRbranch: string;
  committedTime: TimeRange;
  committedFilters: Record<string, string>;
  committedLbranch: string;
  committedRbranch: string;

  // may key to track of the benchamrk
  benchmarkId: string;

  lcommit: BenchmarkCommitMeta | null;
  rcommit: BenchmarkCommitMeta | null;

  setStagedTime: (t: TimeRange) => void;
  setStagedLBranch: (c: string) => void;
  setStagedRBranch: (c: string) => void;
  setStagedFilter: (k: string, v: string) => void;
  setStagedFilters: (filters: Record<string, string>) => void;

  commitMainOptions: () => void;
  revertMainOptions: () => void;

  setLCommit: (commit: BenchmarkCommitMeta | null) => void;
  setRCommit: (commit: BenchmarkCommitMeta | null) => void;

  update: (initial: {
    time?: TimeRange;
    benchmarkId?: string;
    filters?: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lBranch?: string;
    rBranch?: string;
  }) => void;

  hydrateFromUrl: (initial: {
    time: TimeRange;
    benchmarkId: string;
    filters: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lBranch?: string;
    rBranch?: string;
  }) => void;

  reset: (initial: {
    time: TimeRange;
    benchmarkId: string;
    filters: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lBranch?: string;
    rBranch?: string;
  }) => void;
}

export function createDashboardStore(initial: {
  benchmarkId: string;
  time: TimeRange;
  filters: Record<string, string>;
  lbranch: string;
  rbranch: string;
  lcommit?: BenchmarkCommitMeta | null;
  rcommit?: BenchmarkCommitMeta | null;
}) {
  return createWithEqualityFn<BenchmarkDashboardState>()((set, get) => ({
    benchmarkId: initial.benchmarkId, // <-- fixed name

    // staged
    stagedTime: initial.time,
    stagedFilters: initial.filters,
    stagedLbranch: initial.lbranch ?? "",
    stagedRbranch: initial.rbranch ?? "",

    // committed
    committedTime: initial.time,
    committedFilters: initial.filters,
    committedLbranch: initial.lbranch ?? "",
    committedRbranch: initial.rbranch ?? "",

    // current commits
    lcommit: initial.lcommit ?? null,
    rcommit: initial.rcommit ?? null,

    // actions...
    setStagedLBranch: (c) => set({ stagedLbranch: c }),
    setStagedRBranch: (c) => set({ stagedRbranch: c }),
    setStagedTime: (t) => set({ stagedTime: t }),
    setStagedFilter: (k, v) =>
      set((s) => ({ stagedFilters: { ...s.stagedFilters, [k]: v } })),
    setStagedFilters: (filters) =>
      set((s) => ({ stagedFilters: { ...s.stagedFilters, ...filters } })),

    commitMainOptions: () =>
      set({
        committedTime: get().stagedTime,
        committedFilters: get().stagedFilters,
        committedLbranch: get().stagedLbranch,
        committedRbranch: get().stagedRbranch,
      }),

    revertMainOptions: () =>
      set({
        stagedTime: get().committedTime,
        stagedFilters: get().committedFilters,
        stagedLbranch: get().committedLbranch,
        stagedRbranch: get().committedRbranch,
      }),

    setLCommit: (commit) => set({ lcommit: commit }),
    setRCommit: (commit) => set({ rcommit: commit }),

    reset: (next) =>
      set({
        stagedTime: next.time,
        committedTime: next.time,
        stagedFilters: next.filters,
        committedFilters: next.filters,
        stagedLbranch: next.lBranch ?? "",
        stagedRbranch: next.rBranch ?? "",
        committedLbranch: next.lBranch ?? "",
        committedRbranch: next.rBranch ?? "",
        lcommit: next.lcommit ?? null,
        rcommit: next.rcommit ?? null,
        // (optional) benchmarkId: next.benchmarkId,
      }),

    update: (next) =>{
      set((s) => ({
        // important to keep the benchmarkId as original if not specified
        benchmarkId: next.benchmarkId?? s.benchmarkId,
        // staged
        stagedTime: next.time ?? s.stagedTime,
        stagedFilters: next.filters ?? s.stagedFilters,
        stagedLbranch: next.lBranch ?? s.stagedLbranch ?? "",
        stagedRbranch: next.rBranch ?? s.stagedRbranch ?? "",
        // committed mirrors staged on first load
        committedTime: next.time?? s.committedTime,
        committedFilters: next.filters?? s.committedFilters,
        committedLbranch: next.lBranch ?? s.committedLbranch ?? "",
        committedRbranch: next.lBranch ?? s.committedRbranch ?? "",
        lcommit: next.lcommit ?? null,
        rcommit: next.rcommit ?? null,

      }))
    },

  hydrateFromUrl: ({
    time,
    filters,
    benchmarkId,
    lBranch,
    rBranch,
    lcommit,
    rcommit,
  }) =>{
    let timeRange = undefined
    if (time?.end && time?.start){
      timeRange = {
        start: dayjs.utc(time.start),
        end: dayjs.utc(time.end)
      }
    }
    return get().update({
      time: timeRange,
      filters,
      benchmarkId,
      lBranch,
      rBranch,
      lcommit,
      rcommit,
    })
  },
  }));


}
