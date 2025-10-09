// components/Sidebar.tsx
"use client";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { QueryParameterConverterInputs } from "components/benchmark/v3/configs/utils/dataBindingRegistration";
import { UMCopyLink } from "components/uiModules/UMCopyLink";
import { UMDateButtonPicker } from "components/uiModules/UMDateRangePicker";
import { UMDenseButtonLight } from "components/uiModules/UMDenseComponents";
import dayjs from "dayjs";
import { useBenchmarkCommitsData } from "lib/benchmark/api_helper/apis/hooks";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { useRouter } from "next/router";
import { useEffect, useRef } from "react";
import { BenchmarkUIConfigBook } from "../../../configs/configBook";
import { DenseAlert } from "../../common/styledComponents";
import { BranchDropdowns } from "./BranchDropdown";
import { MaxSamplingInput } from "./SamplingInput";
import { useUrlStoreSync } from "./useUrlSync";

const styles = {
  root: {
    marginBottom: 2,
  },
};
/**
 * section of benchmark side bar that affect the data fetching and rendering,
 * including time range, metric filters, and branch selection
 *
 * @returns
 *
 */
export function SideBarMainSection() {
  const router = useRouter();
  const hydrateFromUrl = useDashboardSelector((s) => s.hydrateFromUrl);

  const committedState = useDashboardSelector((s) => ({
    time: s.committedTime,
    filters: s.committedFilters,
    lcommit: s.lcommit,
    rcommit: s.rcommit,
    lbranch: s.committedLbranch,
    rbranch: s.committedRbranch,
  }));

  // sync the url with the store
  const { pushUrlFromStore } = useUrlStoreSync(
    router,
    committedState,
    hydrateFromUrl
  );

  // make the url in sync with the state of the store
  // pushUrlFromStore();

  // 1) Read benchmarkId (low-churn) to fetch config
  const benchmarkId = useDashboardSelector((s) => s.benchmarkId);
  const config = BenchmarkUIConfigBook.instance.get(benchmarkId);
  const dataBinding =
    BenchmarkUIConfigBook.instance.getDataBinding(benchmarkId);
  const required_filter_fields = config?.required_filter_fields ?? [];

  // 2) One selector (with shallow inside useDashboardSelector) for the rest
  const {
    stagedTime,
    stagedFilters,
    stagedLbranch,
    stagedRbranch,
    stagedMaxSampling,
    setStagedTime,
    setStagedLBranch,
    setStagedRBranch,
    setStagedMaxSampling,
    lcommit,
    rcommit,
    committedTime,
    committedFilters,
    committedLbranch,
    committedRbranch,
    committedMaxSampling,
    enableSamplingSetting,
    commitMainOptions,
    revertMainOptions,
  } = useDashboardSelector((s) => ({
    stagedTime: s.stagedTime,
    stagedFilters: s.stagedFilters,
    stagedLbranch: s.stagedLbranch,
    stagedRbranch: s.stagedRbranch,
    stagedMaxSampling: s.stagedMaxSampling,

    setStagedTime: s.setStagedTime,
    setStagedLBranch: s.setStagedLbranch,
    setStagedRBranch: s.setStagedRbranch,
    setStagedMaxSampling: s.setStagedMaxSampling,

    committedTime: s.committedTime,
    committedFilters: s.committedFilters,
    committedLbranch: s.committedLbranch,
    committedRbranch: s.committedRbranch,
    committedMaxSampling: s.committedMaxSampling,

    enableSamplingSetting: s.enableSamplingSetting,
    lcommit: s.lcommit,
    rcommit: s.rcommit,

    commitMainOptions: s.commitMainOptions,
    revertMainOptions: s.revertMainOptions,
  }));

  // trick to record the sig of the branches from previous rendering
  const branchSigRef = useRef<string>("");

  const ready =
    !!stagedTime?.start &&
    !!stagedTime?.end &&
    (enableSamplingSetting ? !!stagedMaxSampling : true) &&
    required_filter_fields.every((k) => !!committedFilters[k]);

  const params = BenchmarkUIConfigBook.instance
    .getDataBinding(benchmarkId)
    ?.toQueryParams({
      timeRange: stagedTime,
      filters: stagedFilters,
      maxSampling: stagedMaxSampling,
    } as QueryParameterConverterInputs);

  if (!params) {
    throw new Error(`Failed to convert to query params for ${benchmarkId}`);
  }

  const queryParams: any | null = ready ? params : null;

  const {
    data: commitsData,
    isLoading: isCommitsLoading,
    error: commitsError,
  } = useBenchmarkCommitsData(benchmarkId, queryParams);

  const branches = commitsData?.metadata?.branches ?? [];
  const is_samplied = commitsData?.metadata?.is_samplied ?? false;
  const sampling_info = commitsData?.metadata?.sampling_info;

  // update staged branches option if they are not in the list
  useEffect(() => {
    const sig = branches.join("|");
    // trick to avoid infinite rendering
    if (branchSigRef.current === sig) return;
    branchSigRef.current = sig;

    if (branches.length === 0) return;

    if (!stagedLbranch || !branches.includes(stagedLbranch)) {
      setStagedLBranch(branches[0] ?? null);
    }
    if (!stagedRbranch || !branches.includes(stagedRbranch)) {
      setStagedRBranch(branches[branches.length - 1] ?? null);
    }
  }, [branches]);

  const DropdownComp = dataBinding?.getFilterOptionComponent();

  // indicates if the user has made changes to the options
  const dirty =
    stagedTime.start.valueOf() !== committedTime.start.valueOf() ||
    stagedTime.end.valueOf() !== committedTime.end.valueOf() ||
    stagedLbranch !== committedLbranch ||
    stagedRbranch !== committedRbranch ||
    stagedMaxSampling !== committedMaxSampling ||
    JSON.stringify(stagedFilters) !== JSON.stringify(committedFilters);

  // indicates no branches found based on the time range and options
  const noData = branches && branches.length === 0;

  const disableApply = !dirty || noData || isCommitsLoading;

  const showSamplinginfo = is_samplied && !isCommitsLoading;
  return (
    <Stack spacing={2} sx={styles.root}>
      <Stack direction="row" alignItems="center" spacing={0}>
        <Typography variant="body2" sx={{ fontSize: "0.65rem" }}>
          Share link:
        </Typography>
        <UMCopyLink
          params={{
            time: committedTime,
            filters: committedFilters,
            lbranch: committedLbranch,
            rbranch: committedRbranch,
            rcommit: rcommit,
            lcommit: lcommit,
          }}
        />
      </Stack>
      <UMDateButtonPicker
        setTimeRange={(start: dayjs.Dayjs, end: dayjs.Dayjs) =>
          setStagedTime({ start, end })
        }
        start={stagedTime.start}
        end={stagedTime.end}
        gap={0}
      />
      <Divider />
      {/* Fetch Settings */}
      <Typography variant="subtitle2">Fetch Settings</Typography>
      {enableSamplingSetting && stagedMaxSampling && (
        <MaxSamplingInput
          value={stagedMaxSampling}
          onChange={setStagedMaxSampling}
        />
      )}
      {showSamplinginfo && (
        <DenseAlert severity="info">
          {`Data Sampling: subsample from ${sampling_info?.origin ?? 0} to ${
            sampling_info?.result ?? 0
          }`}
        </DenseAlert>
      )}
      <Divider />
      {/* Dropdown filters */}
      <Typography variant="subtitle2">Filters</Typography>
      <Stack spacing={1.5}>
        <DropdownComp />
      </Stack>
      {!isCommitsLoading && !commitsError && (
        <BranchDropdowns
          type="single"
          lbranch={stagedLbranch}
          rbranch={stagedRbranch}
          setLbranch={setStagedLBranch}
          setRbranch={setStagedRBranch}
          branchOptions={branches}
        />
      )}
      {/* Apply / Revert */}
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ visibility: !disableApply ? "visible" : "hidden" }}
        aria-hidden={!disableApply}
      >
        Click apply to submit your changes
      </Typography>
      <Stack direction="row" spacing={1}>
        <UMDenseButtonLight
          variant="outlined"
          disabled={!dirty}
          onClick={revertMainOptions}
        >
          Revert
        </UMDenseButtonLight>
        <UMDenseButtonLight
          variant="contained"
          disabled={disableApply}
          onClick={commitMainOptions}
        >
          Apply
        </UMDenseButtonLight>
      </Stack>
    </Stack>
  );
}
