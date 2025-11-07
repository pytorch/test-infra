// benchmark_regression_store.ts
import { BenchmarkPageType } from "components/benchmark_v3/configs/config_book_types";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { createWithEqualityFn } from "zustand/traditional";
import { BENCHMARK_ID_MAPPING } from "../../../components/benchmark_v3/configs/configurations";

export type TimeRange = { start: Dayjs; end: Dayjs };
type KV = Record<string, string | null>;


export type BenchmarkCommitMeta = {
  commit: string;
  date: string;
  branch: string;
  workflow_id: string;
  index?: number;
};

/**
 * Data model for BenchmarkDashboardState
 */
export interface BenchmarkDashboardState {
  stagedTime: TimeRange;
  stagedFilters: Record<string, string>;
  stagedLbranch: string;
  stagedRbranch: string;
  stagedLcommit: BenchmarkCommitMeta | null;
  stagedRcommit: BenchmarkCommitMeta | null;

  // manage the ui switch within the same page
  // this is used when user switch between different ui view within the same store state
  renderGroupId: string;

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


  enableMultiBranchOption?:boolean;
  branchOptionType: string

  // may key to track of the benchamrk
  benchmarkId: string;
  type: BenchmarkPageType;
  benchmarkName: string;
  repo: string;

  lcommit: BenchmarkCommitMeta | null;
  rcommit: BenchmarkCommitMeta | null;

  setStagedMaxSampling: (c: number) => void;
  setStagedTime: (t: TimeRange) => void;
  setStagedLbranch: (c: string) => void;
  setStagedRbranch: (c: string) => void;
  setStagedFilter: (k: string, v: string) => void;
  setStagedFilters: (filters: Record<string, string>) => void;
  setStagedLcommit: (c: BenchmarkCommitMeta | null) => void;
  setStagedRcommit: (c: BenchmarkCommitMeta | null) => void;

  commitMainOptions: () => void;
  revertMainOptions: () => void;

  setEnableSamplingSetting: (enable: boolean) => void;

  setBranchOptionType:(type:string) => void;
  setLcommit: (commit: BenchmarkCommitMeta | null) => void;
  setRcommit: (commit: BenchmarkCommitMeta | null) => void;

  setRenderGroupId: (c: string) => void;

  update: (initial: {
    renderGroupId?: string;
    time?: TimeRange;
    benchmarkId?: string;
    filters?: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lbranch?: string;
    rbranch?: string;
    maxSampling?: number;
  }) => void;

  hydrateFromUrl: (initial: {
    time: TimeRange;
    benchmarkId: string;
    filters: Record<string, string>;
    lcommit?: BenchmarkCommitMeta | null;
    rcommit?: BenchmarkCommitMeta | null;
    lbranch?: string;
    rbranch?: string;
    maxSampling?: number;
    renderGroupId?: string;
  }) => void;
}

export function createDashboardStore(initial: {
  benchmarkId: string;
  type: BenchmarkPageType;
  time: TimeRange;
  filters: Record<string, string>;
  lbranch: string;
  rbranch: string;
  lcommit?: BenchmarkCommitMeta | null;
  rcommit?: BenchmarkCommitMeta | null;
  renderGroupId?: string;
  maxSampling?: number;
  enableMultiBranchOption?: boolean
}) {
  const idItem = BENCHMARK_ID_MAPPING[initial.benchmarkId];
  return createWithEqualityFn<BenchmarkDashboardState>()((set, get) => ({
    benchmarkId: initial.benchmarkId, // <-- fixed name
    type: initial.type,
    benchmarkName:
      idItem?.benchmarkNameMapping?.[initial.type] ??
      idItem.benchmarkName ??
      initial.benchmarkId,
    repo: idItem?.repoName ? idItem.repoName : "pytorch/pytorch",
    // default page switch to the initial type
    // default main means render the page with renders option
    renderGroupId: initial.renderGroupId ?? "main",

    // multi branch setting
    enableMultiBranchOption: (initial.enableMultiBranchOption ?? false),
    branchOptionType: "single",


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

    stagedLcommit: initial.lcommit ?? null,
    stagedRcommit: initial.rcommit ?? null,

    // committed
    committedTime: initial.time,
    committedFilters: initial.filters,
    committedLbranch: initial.lbranch ?? "",
    committedRbranch: initial.rbranch ?? "",

    // current commits
    lcommit: initial.lcommit ?? null,
    rcommit: initial.rcommit ?? null,

    // actions...
    setStagedMaxSampling: (c) => {
      set((s) => {
        if (!s.enableSamplingSetting) return s;
        return {
          stagedMaxSampling: c,
        };
      });
    },

    setRenderGroupId: (c) => set({ renderGroupId: c }),

    setStagedLbranch: (c) => set({ stagedLbranch: c }),
    setStagedRbranch: (c) => set({ stagedRbranch: c }),
    setStagedLcommit: (c) => set({ stagedLcommit: c }),
    setStagedRcommit: (c) => set({ stagedRcommit: c }),

    setStagedTime: (t) => set({ stagedTime: t }),
    setStagedFilter: (k, v) =>
      set((s) => ({ stagedFilters: { ...s.stagedFilters, [k]: v } })),
    setStagedFilters: (filters) =>
      set((s) => ({ stagedFilters: { ...s.stagedFilters, ...filters } })),

    setBranchOptionType:(type) => {
      set((s) => {
        if (!s.enableMultiBranchOption) return s;
        if (type === s.branchOptionType){
          return s;
        }
        if (type == "single"){
          return {
          branchOptionType:type,
          committedRbranch: s.committedLbranch,
          stagedRbranch: s.stagedLbranch
        }
      } else{
         return {
          branchOptionType:type,
        }
      }
      });
    },

    commitMainOptions: () => {
      set((s) => {
        let newState: any = {
          committedTime: s.stagedTime,
          committedFilters: s.stagedFilters,
          committedLbranch: s.stagedLbranch,
          committedRbranch: s.stagedRbranch,
        };

        // set maxSampling
        let maxSampling = s.stagedMaxSampling;
        // reset to undefine if the feature is disabled
        if (!s.enableSamplingSetting) {
          maxSampling = undefined;
        }
        newState = {
          ...newState,
          committedMaxSampling: maxSampling,
          stagedMaxSampling: maxSampling,
        };
        return newState;
      });
    },

    revertMainOptions: () =>
      set({
        stagedTime: get().committedTime,
        stagedFilters: get().committedFilters,
        stagedLbranch: get().committedLbranch,
        stagedRbranch: get().committedRbranch,
        stagedMaxSampling: get().committedMaxSampling,
      }),

    setEnableSamplingSetting: (enable) =>
      set({ enableSamplingSetting: enable }),
    setLcommit: (commit) => set({ lcommit: commit }),
    setRcommit: (commit) => set({ rcommit: commit }),

    update: (next) => {
      set((s) => {
        let newState: any = {
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
          committedRbranch: next.rbranch ?? s.committedRbranch ?? "",

          stagedLcommit:
            next.lcommit !== undefined ? next.lcommit : s.stagedLcommit,
          stagedRcommit:
            next.rcommit !== undefined ? next.rcommit : s.stagedRcommit,

          lcommit: next.lcommit !== undefined ? next.lcommit : s.lcommit,
          rcommit: next.rcommit !== undefined ? next.rcommit : s.rcommit,

          renderGroupId: next.renderGroupId ?? s.renderGroupId,
        };

        // set maxSampling
        let nextMaxSampling = next.maxSampling ?? s.committedMaxSampling;
        // reset to undefine if the feature is disabled
        if (!s.enableSamplingSetting) {
          nextMaxSampling = undefined;
        }

        newState = {
          ...newState,
          committedMaxSampling: nextMaxSampling,
          stagedMaxSampling: nextMaxSampling,
        };
        return newState;
      });
    },

    hydrateFromUrl: ({
      time,
      filters,
      benchmarkId,
      lbranch,
      rbranch,
      lcommit,
      rcommit,
      maxSampling,
      renderGroupId,
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
        maxSampling,
        renderGroupId,
      });
    },
  }));
}
