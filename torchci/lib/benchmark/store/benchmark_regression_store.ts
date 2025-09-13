// benchmark_regression_store.ts
import type { Dayjs } from "dayjs";
import { create } from 'zustand';

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
  stagedLbranch: string
  stagedRbranch: string
  committedTime: TimeRange;
  committedFilters: Record<string, string>;
  committedLbranch: string
  committedRbranch: string

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

  reset: (initial: {
    time: TimeRange;
    filters: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lbranch?: string;
    rbranch?: string;
  }) => void;
}

export function createDashboardStore(initial: {
  time: TimeRange;
  filters: Record<string, string>;
  lcommit?: BenchmarkCommitMeta;
  rcommit?: BenchmarkCommitMeta;
}) {
  return create<BenchmarkDashboardState>((set, get) => ({

    // staged options are the ones that are currently being edited
    stagedTime: initial.time,
    stagedFilters: initial.filters,
    stagedLbranch: initial.lcommit?.branch ?? '',
    stagedRbranch: initial.rcommit?.branch ?? '',

    // committed options are the ones that are currently being applied
    committedTime: initial.time,
    committedFilters: initial.filters,
    committedLbranch: initial.lcommit?.branch ?? '',
    committedRbranch: initial.rcommit?.branch ?? '',

    // current commits that are being picked
    lcommit: initial.lcommit ?? null,
    rcommit: initial.rcommit ?? null,

    setStagedLBranch: (c) => set({ stagedLbranch: c }),
    setStagedRBranch: (c) => set({ stagedRbranch: c }),

    setStagedTime: (t) => set({ stagedTime: t }),
    setStagedFilter: (k, v) =>
      set((s) => ({ stagedFilters: { ...s.stagedFilters, [k]: v } })),
    setStagedFilters: (filters) =>
      set((state) => ({
        stagedFilters: { ...state.stagedFilters, ...filters },
      })),

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
        stagedLbranch: next.lcommit?.branch ?? 'main',
        stagedRbranch: next.rcommit?.branch ?? 'main',
        committedLbranch: next.lcommit?.branch ?? 'main',
        committedRbranch: next.rcommit?.branch ?? 'main',
        lcommit: next.lcommit ?? null,
        rcommit: next.rcommit ?? null,

      }),
  }));
}
