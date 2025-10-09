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

  enableSamplingSetting?: boolean;
  // max sampling threshold, if null, no limit.
  // otherwise, we subsampling data in backend to fit the limit during the data
  committedMaxSampling?: number;
  // TODO(elainewy): may allow user to set a different max sampling threshold based on their needs.
  stagedMaxSampling?: number;

  // may key to track of the benchamrk
  benchmarkId: string;

  lcommit: BenchmarkCommitMeta | null;
  rcommit: BenchmarkCommitMeta | null;

  setStagedMaxSampling: (c: number) => void;
  setStagedTime: (t: TimeRange) => void;
  setStagedLbranch: (c: string) => void;
  setStagedRbranch: (c: string) => void;
  setStagedFilter: (k: string, v: string) => void;
  setStagedFilters: (filters: Record<string, string>) => void;

  commitMainOptions: () => void;
  revertMainOptions: () => void;

  setLcommit: (commit: BenchmarkCommitMeta | null) => void;
  setRcommit: (commit: BenchmarkCommitMeta | null) => void;

  update: (initial: {
    time?: TimeRange;
    benchmarkId?: string;
    filters?: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lbranch?: string;
    rbranch?: string;
  }) => void;

  hydrateFromUrl: (initial: {
    time: TimeRange;
    benchmarkId: string;
    filters: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lbranch?: string;
    rbranch?: string;
  }) => void;

  reset: (initial: {
    time: TimeRange;
    benchmarkId: string;
    filters: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lbranch?: string;
    rbranch?: string;
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
  maxSampling?: number;
}) {
  return createWithEqualityFn<BenchmarkDashboardState>()((set, get) => ({
    benchmarkId: initial.benchmarkId, // <-- fixed name

    // set only with initial config
    enableSamplingSetting: (initial.maxSampling ?? 0) > 0,
    // max sampling threshold, if null, no limit.
    // otherwise, we subsampling data in backend to fit the limit during the data
    // the min sampling threshold is 10
    committedMaxSampling: initial.maxSampling,

    // todo(elainewy): may allow user to set a different max sampling threshold based on their needs
    stagedMaxSampling: initial.maxSampling,

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
    setStagedMaxSampling: (c) => set({ stagedMaxSampling: c }),
    setStagedLbranch: (c) => set({ stagedLbranch: c }),
    setStagedRbranch: (c) => set({ stagedRbranch: c }),
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
        committedMaxSampling: get().stagedMaxSampling,
      }),

    revertMainOptions: () =>
      set({
        stagedTime: get().committedTime,
        stagedFilters: get().committedFilters,
        stagedLbranch: get().committedLbranch,
        stagedRbranch: get().committedRbranch,
        stagedMaxSampling: get().committedMaxSampling,
      }),

    setLcommit: (commit) => set({ lcommit: commit }),
    setRcommit: (commit) => set({ rcommit: commit }),

    reset: (next) =>
      set({
        stagedTime: next.time,
        committedTime: next.time,
        stagedFilters: next.filters,
        committedFilters: next.filters,
        stagedLbranch: next.lbranch ?? "",
        stagedRbranch: next.rbranch ?? "",
        committedLbranch: next.lbranch ?? "",
        committedRbranch: next.rbranch ?? "",
        lcommit: next.lcommit ?? null,
        rcommit: next.rcommit ?? null,
        // (optional) benchmarkId: next.benchmarkId,
      }),

    update: (next) => {
      set((s) => ({
        // important to keep the benchmarkId as original if not specified
        benchmarkId: next.benchmarkId ?? s.benchmarkId,
        // staged
        stagedTime: next.time ?? s.stagedTime,
        stagedFilters: next.filters ?? s.stagedFilters,
        stagedLbranch: next.lbranch ?? s.stagedLbranch ?? "",
        stagedRbranch: next.rbranch ?? s.stagedRbranch ?? "",
        // committed mirrors staged on first load
        committedTime: next.time ?? s.committedTime,
        committedFilters: next.filters ?? s.committedFilters,
        committedLbranch: next.lbranch ?? s.committedLbranch ?? "",
        committedRbranch: next.lbranch ?? s.committedRbranch ?? "",
        lcommit: next.lcommit ?? null,
        rcommit: next.rcommit ?? null,
      }));
    },

    hydrateFromUrl: ({
      time,
      filters,
      benchmarkId,
      lbranch,
      rbranch,
      lcommit,
      rcommit,
    }) => {
      let timeRange = undefined;
      if (time?.end && time?.start) {
        timeRange = {
          start: dayjs.utc(time.start),
          end: dayjs.utc(time.end),
        };
      }
      return get().update({
        time: timeRange,
        filters,
        benchmarkId,
        lbranch,
        rbranch,
        lcommit,
        rcommit,
      });
    },
  }));
}
