// components/Sidebar.tsx
"use client";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { getSideBarMetricsComponent } from "components/benchmark/v3/configs/configRegistration";
import { UMDateButtonPicker } from "components/uiModules/UMDateRangePicker";
import dayjs from "dayjs";
import { useBenchmarkCommitsData } from "lib/benchmark/api_helper/compilers/type";
import { useDashboardStore } from "lib/benchmark/store/benchmark_dashboard_provider";
import { useEffect, useRef } from "react";
import { BenchmarkUIConfigBook } from "../../../configs/configBook";
import { BranchDropdowns } from "./BranchDropdown";

export function Sidebar() {
  const useStore = useDashboardStore();
  const benchmarkId = useStore((s) => s.benchamrkId);
  const config = BenchmarkUIConfigBook[benchmarkId];
  const required_filter_fields = config.required_filter_fields ?? [];

  const stagedTime = useStore((s) => s.stagedTime);
  const stagedFilters = useStore((s) => s.stagedFilters);
  const stagedLbranch = useStore((s) => s.stagedLbranch);
  const stagedRbranch = useStore((s) => s.stagedRbranch);

  const setStagedTime = useStore((s) => s.setStagedTime);
  const setStagedLBranch = useStore((s) => s.setStagedLBranch);
  const setStagedRBranch = useStore((s) => s.setStagedRBranch);

  const committedTime = useStore((s) => s.committedTime);
  const committedFilters = useStore((s) => s.committedFilters);
  const committedL = useStore((s) => s.committedLbranch);
  const committedR = useStore((s) => s.committedRbranch);

  const commitMainOptions = useStore((s) => s.commitMainOptions);
  const revertMainOptions = useStore((s) => s.revertMainOptions);

  // trick to record the sig of the branches from previous rendering
  const branchSigRef = useRef<string>("");

  const ready =
    !!stagedTime?.start &&
    !!stagedTime?.end &&
    required_filter_fields.every((k) => !!committedFilters[k]);

  const {
    data: commitsData,
    isLoading: isCommitsLoading,
    error: commitsError,
  } = useBenchmarkCommitsData(
    benchmarkId,
    ready,
    stagedTime,
    stagedFilters,
    [] // fetches all commits during the given time range and filters
  );

  const branches = commitsData?.metadata?.branches ?? [];

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

  const DropdownComp = getSideBarMetricsComponent(config);

  const dirty =
    stagedTime.start.valueOf() !== committedTime.start.valueOf() ||
    stagedTime.end.valueOf() !== committedTime.end.valueOf() ||
    stagedLbranch !== committedL ||
    stagedRbranch !== committedR ||
    JSON.stringify(stagedFilters) !== JSON.stringify(committedFilters);

  // indicates no branches found based on the time range and options
  const noData = branches && branches.length === 0;

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Search</Typography>
      <UMDateButtonPicker
        setTimeRange={(start: dayjs.Dayjs, end: dayjs.Dayjs) =>
          setStagedTime({ start, end })
        }
        start={stagedTime.start}
        end={stagedTime.end}
      />
      <Divider />
      {/* Dropdown filters */}
      <Typography variant="subtitle2">Filters</Typography>
      <Stack spacing={1.5}>
        <DropdownComp />
      </Stack>
      {!isCommitsLoading && !commitsError && (
        <BranchDropdowns
          type="single"
          lBranch={stagedLbranch}
          rBranch={stagedRbranch}
          setLBranch={setStagedLBranch}
          setRBranch={setStagedRBranch}
          branchOptions={branches}
        />
      )}
      <Divider />
      {/* Apply / Revert */}
      <Stack direction="row" spacing={1}>
        <Button
          variant="outlined"
          disabled={!dirty}
          onClick={revertMainOptions}
        >
          Revert
        </Button>
        <Button
          variant="contained"
          disabled={!dirty || noData}
          onClick={commitMainOptions}
        >
          Apply
        </Button>
      </Stack>
    </Stack>
  );
}
