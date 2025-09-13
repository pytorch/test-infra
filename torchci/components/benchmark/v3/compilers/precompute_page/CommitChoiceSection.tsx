import { Button, FormControl, InputLabel, MenuItem, Select, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { DISPLAY_NAMES_TO_ARCH_NAMES, DISPLAY_NAMES_TO_DEVICE_NAMES } from "components/benchmark/compilers/common";
import { UMDenseCommitDropdown } from "components/uiModules/UMDenseComponents";
import dayjs from "dayjs";
import { useBenchmarkCommitsData } from "lib/benchmark/api_helper/compilers/type";
import { useDashboardStore } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useEffect, useState } from "react";

export const REQUIRED_KEYS = ["mode", "dtype", "deviceName"] as const;

export function CommitChoiceSection({ benchmarkId }: { benchmarkId?: string }) {
    const  useStore= useDashboardStore();

  const committedTime      = useStore(s => s.committedTime);
  const committedFilters   = useStore(s => s.committedFilters);
  const lcommit            = useStore(s => s.lcommit);
  const rcommit            = useStore(s => s.rcommit);
  const setLCommit         = useStore(s => s.setLCommit);
  const setRCommit         = useStore(s => s.setRCommit);

  const [leftList, setLeftList]   = useState<BenchmarkCommitMeta[]>([]);
  const [rightList, setRightList] = useState<BenchmarkCommitMeta[]>([]);
  const [autoLeftSha, setAutoLeftSha]   = useState<string | null>(null);
  const [autoRightSha, setAutoRightSha] = useState<string | null>(null);

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    REQUIRED_KEYS.every((k) => !!committedFilters[k]);

  useEffect(() => {
    if (!ready) {
      setLeftList([]);
      setRightList([]);
      setAutoLeftSha(null);
      setAutoRightSha(null);
      setLCommit(null);
      setRCommit(null);
    }
  }, [ready, setLCommit, setRCommit]);

  const baseParams: any | null = ready
    ? {
        benchmarkId,
        startTime: dayjs.utc(committedTime.start).format("YYYY-MM-DDTHH:mm:ss"),
        stopTime:  dayjs.utc(committedTime.end).format("YYYY-MM-DDTHH:mm:ss"),
        arch: DISPLAY_NAMES_TO_ARCH_NAMES[committedFilters.deviceName],
        device: DISPLAY_NAMES_TO_DEVICE_NAMES[committedFilters.deviceName],
        dtype: committedFilters.dtype,
        mode: committedFilters.mode,
        branch: ["main"],
      }
    : null;

  // Fetch data
  const { data, isLoading, error } = useBenchmarkCommitsData("compiler", baseParams);

  // Helper
  const inList = (list: BenchmarkCommitMeta[], workflow_id?: string | null) =>
    !!workflow_id && list.some((c) => c.workflow_id === workflow_id);

  // Sync lists & auto-picks when data / selection changes
  useEffect(() => {
    const L: BenchmarkCommitMeta[] | undefined = data?.left ?? data?.data ?? [];
    const R: BenchmarkCommitMeta[] | undefined = data?.right ?? data?.data ?? [];
    if (!L || !R) return;

    setLeftList(L);
    setRightList(R);

    const nextAutoL = inList(L, lcommit?.workflow_id) ? lcommit!.workflow_id : L[0]?.workflow_id ?? null;
    const nextAutoR = inList(R, rcommit?.workflow_id) ? rcommit!.workflow_id : R[R.length - 1]?.workflow_id ?? null;

    setAutoLeftSha(nextAutoL);
    setAutoRightSha(nextAutoR);

    console.log("dataaaaa", data);

    if (!inList(L, lcommit?.workflow_id)) {
      setLCommit(nextAutoL ? L.find((c) => c.workflow_id === nextAutoL) ?? null : null);
    }
    if (!inList(R, rcommit?.workflow_id)) {
      setRCommit(nextAutoR ? R.find((c) => c.workflow_id === nextAutoR) ?? null : null);
    }
  }, [data, lcommit?.workflow_id, rcommit?.workflow_id, setLCommit, setRCommit]); // ✅ correct deps

  if (error) return <div>Error: {error.message}</div>;
  if (isLoading || !data) return null;

  const leftChangedByUser  = !!lcommit?.workflow_id && autoLeftSha  != null && lcommit.workflow_id  !== autoLeftSha;
  const rightChangedByUser = !!rcommit?.workflow_id && autoRightSha != null && rcommit.workflow_id !== autoRightSha;

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Commits</Typography>
      <UMDenseCommitDropdown
        label={"lbl-left"}
        disable={!ready || leftList.length === 0 || isLoading}
        selectedCommit={lcommit}
        commitList={leftList}
        setCommit={setLCommit}
      />
      <UMDenseCommitDropdown
        label={"lbl-right"}
        disable={!ready || rightList.length === 0 || isLoading}
        selectedCommit={rcommit}
        commitList={rightList}
        setCommit={setRCommit}
      />

      {(leftChangedByUser || rightChangedByUser) && (
        <Button
          size="small"
          variant="text"
          onClick={() => {
            if (autoLeftSha)  setLCommit(leftList.find((c) => c.commit === autoLeftSha) ?? null);
            if (autoRightSha) setRCommit(rightList.find((c) => c.commit === autoRightSha) ?? null);
          }}
        >
          Reset to auto
        </Button>
      )}
    </Stack>
  );
}
