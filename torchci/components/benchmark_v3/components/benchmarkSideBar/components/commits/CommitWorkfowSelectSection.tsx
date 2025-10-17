import { Typography } from "@mui/material";
import { Stack } from "@mui/system";
import { QueryParameterConverterInputs } from "components/benchmark_v3/configs/utils/dataBindingRegistration";
import { CenteredLoader } from "components/common/LoadingIcon";
import { UMDenseCommitDropdown } from "components/uiModules/UMDenseComponents";
import { useBenchmarkCommitsData } from "lib/benchmark/api_helper/fe/hooks";
import { useBenchmarkBook } from "lib/benchmark/store/benchmark_config_book";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useEffect, useState } from "react";

/**
 *
 * @returns
 *
 */
export function CommitWorflowSelectSection() {
  const {
    repo,
    type,
    benchmarkName,
    benchmarkId,
    committedTime,
    committedFilters,
    lcommit,
    rcommit,
    committedLBranch,
    committedRBranch,
    committedMaxSampling,
    enableSamplingSetting,
    setLcommit,
    setRcommit,
  } = useDashboardSelector((s) => ({
    type: s.type,
    benchmarkId: s.benchmarkId,
    committedTime: s.committedTime,
    committedFilters: s.committedFilters,
    committedMaxSampling: s.committedMaxSampling,
    enableSamplingSetting: s.enableSamplingSetting,
    repo: s.repo,
    benchmarkName: s.benchmarkName,
    lcommit: s.lcommit,
    rcommit: s.rcommit,
    committedLBranch: s.committedLbranch,
    committedRBranch: s.committedRbranch,
    setLcommit: s.setLcommit,
    setRcommit: s.setRcommit,
  }));

  const [leftList, setLeftList] = useState<BenchmarkCommitMeta[]>([]);
  const [rightList, setRightList] = useState<BenchmarkCommitMeta[]>([]);

  const getConfig = useBenchmarkBook((s) => s.getConfig);
  const config = getConfig(benchmarkId, type);
  const dataBinding = config.dataBinding;
  const required_filter_fields = config.raw?.required_filter_fields ?? [];

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    !!committedLBranch &&
    committedLBranch.length > 0 &&
    !!committedRBranch &&
    committedRBranch.length > 0 &&
    (enableSamplingSetting ? committedMaxSampling : true) &&
    required_filter_fields.every((k) => !!committedFilters[k]);

  // Fetch data
  const branches = [
    ...new Set(
      [committedLBranch, committedRBranch].filter((b) => b.length > 0)
    ),
  ];

  // Convert to query params
  const params = dataBinding.toQueryParams({
    repo: repo,
    benchmarkName: benchmarkName,
    branches,
    timeRange: committedTime,
    filters: committedFilters,
    maxSampling: enableSamplingSetting ? committedMaxSampling : undefined,
  } as QueryParameterConverterInputs);
  if (!params) {
    throw new Error(`Failed to convert to query params for ${benchmarkId}`);
  }

  const queryParams: any | null = ready ? params : null;

  // Fetch data
  const { data, isLoading, error } = useBenchmarkCommitsData(
    benchmarkId,
    queryParams
  );

  useEffect(() => {
    if (isLoading || !data) return;

    const groups = data?.data?.branch ?? [];
    const branchMap = convertToBranchMap(groups);

    const L: BenchmarkCommitMeta[] = branchMap[committedLBranch] ?? [];
    const R: BenchmarkCommitMeta[] = branchMap[committedRBranch] ?? [];

    // update list
    setLeftList(L);
    setRightList(R);

    if (L.length === 0 || R.length === 0) return;

    // check if user has selected a commit that is not in the list
    const lSelected = lcommit?.workflow_id ?? null;
    const rSelected = rcommit?.workflow_id ?? null;
    const lHas = !!lSelected && L.some((c) => c.workflow_id === lSelected);
    const rHas = !!rSelected && R.some((c) => c.workflow_id === rSelected);

    // rule left pick first workflow, right pick last workflow id
    const nextAutoL = lHas ? lSelected : L[0]?.workflow_id ?? null;
    const nextAutoR = rHas ? rSelected : R[R.length - 1]?.workflow_id ?? null;

    if (!lHas) {
      setLcommit(
        nextAutoL ? L.find((c) => c.workflow_id === nextAutoL) ?? null : null
      );
    }
    if (!rHas) {
      setRcommit(
        nextAutoR ? R.find((c) => c.workflow_id === nextAutoR) ?? null : null
      );
    }
  }, [
    isLoading,
    data,
    committedLBranch,
    committedRBranch,
    lcommit?.workflow_id,
    rcommit?.workflow_id,
    setLcommit,
    setRcommit,
  ]);

  if (error) return <div>Error: {error.message}</div>;
  if (isLoading || !data) return <CenteredLoader />;

  return (
    <Stack spacing={1.5} direction={"row"} alignItems={"center"}>
      <Typography variant="subtitle2" sx={{ minWidth: 100 }}>
        Commit Range:
      </Typography>
      <UMDenseCommitDropdown
        label={"lbl-left"}
        branchName={committedLBranch}
        disable={!ready || leftList.length === 0 || isLoading}
        selectedCommit={lcommit}
        commitList={leftList}
        setCommit={setLcommit}
      />
      <UMDenseCommitDropdown
        label={"lbl-right"}
        branchName={committedRBranch}
        disable={!ready || rightList.length === 0 || isLoading}
        selectedCommit={rcommit}
        commitList={rightList}
        setCommit={setRcommit}
      />
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
