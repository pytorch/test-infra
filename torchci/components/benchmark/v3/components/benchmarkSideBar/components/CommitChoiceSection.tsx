import { Button, Typography } from "@mui/material";
import { Stack } from "@mui/system";
import { UMDenseCommitDropdown } from "components/uiModules/UMDenseComponents";
import { useBenchmarkCommitsData } from "lib/benchmark/api_helper/compilers/type";
import { useDashboardStore } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useEffect, useState } from "react";
import { BenchmarkUIConfigBook } from "../../../configs/configBook";

export function CommitChoiceSection() {
  const useStore = useDashboardStore();

  const benchmarkId = useStore((s) => s.benchamrkId);

  const committedTime = useStore((s) => s.committedTime);
  const committedFilters = useStore((s) => s.committedFilters);
  const lcommit = useStore((s) => s.lcommit);
  const rcommit = useStore((s) => s.rcommit);

  const committedLBranch = useStore((s) => s.committedLbranch);
  const committedRBranch = useStore((s) => s.committedRbranch);

  const setLCommit = useStore((s) => s.setLCommit);
  const setRCommit = useStore((s) => s.setRCommit);

  const [leftList, setLeftList] = useState<BenchmarkCommitMeta[]>([]);
  const [rightList, setRightList] = useState<BenchmarkCommitMeta[]>([]);
  const [autoLeftSha, setAutoLeftSha] = useState<string | null>(null);
  const [autoRightSha, setAutoRightSha] = useState<string | null>(null);

  const config = BenchmarkUIConfigBook[benchmarkId];
  const required_filter_fields = config?.required_filter_fields ?? [];

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    !!committedLBranch &&
    committedLBranch.length > 0 &&
    !!committedRBranch &&
    committedRBranch.length > 0 &&
    required_filter_fields.every((k) => !!committedFilters[k]);

  // Fetch data
  const branches = [
    ...new Set(
      [committedLBranch, committedRBranch].filter((b) => b.length > 0)
    ),
  ];
  const { data, isLoading, error } = useBenchmarkCommitsData(
    benchmarkId,
    ready,
    committedTime,
    committedFilters,
    branches,
    ["branch"]
  );

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

  // Helper
  const inList = (list: BenchmarkCommitMeta[], workflow_id?: string | null) =>
    !!workflow_id && list.some((c) => c.workflow_id === workflow_id);

  // Sync lists & auto-picks when data / selection changes
  useEffect(() => {
    if (!data) return;
    if (isLoading) return;
    const branches = data?.data?.branch ?? [];
    const branchMap = convertToBranchMap(branches);
    const L: BenchmarkCommitMeta[] = branchMap[committedLBranch] ?? [];
    const R: BenchmarkCommitMeta[] = branchMap[committedRBranch] ?? [];

    if (!L || !R) return;
    setLeftList(L);
    setRightList(R);

    const nextAutoL = inList(L, lcommit?.workflow_id)
      ? lcommit!.workflow_id
      : L[0]?.workflow_id ?? null;
    const nextAutoR = inList(R, rcommit?.workflow_id)
      ? rcommit!.workflow_id
      : R[R.length - 1]?.workflow_id ?? null;

    setAutoLeftSha(nextAutoL);
    setAutoRightSha(nextAutoR);

    if (!inList(L, lcommit?.workflow_id)) {
      setLCommit(
        nextAutoL ? L.find((c) => c.workflow_id === nextAutoL) ?? null : null
      );
    }
    if (!inList(R, rcommit?.workflow_id)) {
      setRCommit(
        nextAutoR ? R.find((c) => c.workflow_id === nextAutoR) ?? null : null
      );
    }
  }, [
    data,
    lcommit?.workflow_id,
    rcommit?.workflow_id,
    setLCommit,
    setRCommit,
  ]);

  if (error) return <div>Error: {error.message}</div>;
  if (isLoading || !data) return null;

  const leftChangedByUser =
    !!lcommit?.workflow_id &&
    autoLeftSha != null &&
    lcommit.workflow_id !== autoLeftSha;
  const rightChangedByUser =
    !!rcommit?.workflow_id &&
    autoRightSha != null &&
    rcommit.workflow_id !== autoRightSha;

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Commits</Typography>
      <UMDenseCommitDropdown
        label={"lbl-left"}
        branchName={committedLBranch}
        disable={!ready || leftList.length === 0 || isLoading}
        selectedCommit={lcommit}
        commitList={leftList}
        setCommit={setLCommit}
      />
      <UMDenseCommitDropdown
        label={"lbl-right"}
        branchName={committedRBranch}
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
            if (autoLeftSha)
              setLCommit(
                leftList.find((c) => c.commit === autoLeftSha) ?? null
              );
            if (autoRightSha)
              setRCommit(
                rightList.find((c) => c.commit === autoRightSha) ?? null
              );
          }}
        >
          Reset to auto
        </Button>
      )}
    </Stack>
  );
}

export const convertToBranchMap = (
  raw: any[]
): Record<string, BenchmarkCommitMeta[]> => {
  return raw.reduce((acc, g) => {
    const branch = g?.group_info?.branch ?? "unknown";
    acc[branch] = g.rows.map((r: any) => ({
      commit: r.commit,
      workflow_id: String(r.workflow_id),
      date: r.date,
      branch,
    }));
    return acc;
  }, {} as Record<string, BenchmarkCommitMeta[]>);
};
