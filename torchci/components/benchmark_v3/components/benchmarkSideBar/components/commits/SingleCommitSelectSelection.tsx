import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { useBenchmarkBook } from "components/benchmark_v3/configs/benchmark_config_book";
import { QueryParameterConverterInputs } from "components/benchmark_v3/configs/utils/dataBindingRegistration";
import { CenteredLoader } from "components/common/LoadingIcon";
import {
  UMDenseCommitDropdown,
  UMDenseSingleButton,
} from "components/uiModules/UMDenseComponents";
import { useBenchmarkCommitsData } from "lib/benchmark/api_helper/fe/hooks";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { stateToQuery } from "lib/helpers/urlQuery";
import { NextRouter, useRouter } from "next/router";
import { useEffect, useState } from "react";

export function SingleCommitSelectSelection() {
  const {
    repo,
    type,
    benchmarkName,
    benchmarkId,
    committedTime,
    committedFilters,
    lcommit,
    committedLBranch,
    committedMaxSampling,
    enableSamplingSetting,
    setLcommit,
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
    setLcommit: s.setLcommit,
  }));

  const [leftList, setLeftList] = useState<BenchmarkCommitMeta[]>([]);
  const getConfig = useBenchmarkBook((s) => s.getConfig);
  const config = getConfig(benchmarkId, type);
  const dataBinding = config.dataBinding;
  const required_filter_fields = config.raw?.required_filter_fields ?? [];

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    !!committedLBranch &&
    committedLBranch.length > 0 &&
    (enableSamplingSetting ? committedMaxSampling : true) &&
    required_filter_fields.every((k) => !!committedFilters[k]);

  // Fetch data
  const branches = [...new Set([committedLBranch].filter((b) => b.length > 0))];

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

    // update list
    setLeftList(L);

    if (L.length === 0) return;

    // check if user has selected a commit that is not in the list
    const lSelected = lcommit?.workflow_id ?? null;

    const lHas = !!lSelected && L.some((c) => c.workflow_id === lSelected);

    // rule left and right both pick left option
    const nextAutoL = lHas ? lSelected : L[0]?.workflow_id ?? null;

    if (!lHas) {
      setLcommit(
        nextAutoL ? L.find((c) => c.workflow_id === nextAutoL) ?? null : null
      );
    }
  }, [isLoading, data, committedLBranch, lcommit?.workflow_id, setLcommit]);

  if (error) return <div>Error: {error.message}</div>;
  if (isLoading || !data) return <CenteredLoader />;

  return (
    <Stack spacing={1.5} direction={"row"} alignItems={"center"}>
      <Typography variant="subtitle2" sx={{ minWidth: 50 }}>
        Commit:
      </Typography>
      <Box
        sx={{
          whiteSpace: "nowrap",
        }}
      >
        {lcommit?.branch}:
      </Box>
      <UMDenseCommitDropdown
        label={"run"}
        branchName={committedLBranch}
        disable={!ready || leftList.length === 0 || isLoading}
        selectedCommit={lcommit}
        commitList={leftList}
        setCommit={(c) => {
          setLcommit(c);
        }}
      />
      <NavigateToDashboardButton benchmarkId={benchmarkId} commit={lcommit} />
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

export function NavigateToDashboardButton({
  benchmarkId,
  commit,
}: {
  benchmarkId: string;
  commit: BenchmarkCommitMeta | null;
}) {
  const router = useRouter();
  if (!commit) {
    return <></>;
  }
  return (
    <UMDenseSingleButton
      component="a"
      href={toDashboardUrl(benchmarkId, commit, router)}
      size="small"
      variant="outlined"
      color="primary"
      endIcon={<OpenInNewIcon fontSize="small" />}
      sx={{
        whiteSpace: "nowrap",
      }}
    >
      View {commit.workflow_id} ({commit.commit.slice(0, 7)}) in Dashboard
    </UMDenseSingleButton>
  );
}

export function toDashboardUrl(
  benchmarkId: string,
  commit: BenchmarkCommitMeta,
  router: NextRouter
) {
  const pathname = `/benchmark/v3/dashboard/${benchmarkId}`;
  const lcommit: BenchmarkCommitMeta = commit;
  const rcommit: BenchmarkCommitMeta = commit;
  const reformattedPrams = stateToQuery({
    lcommit,
    rcommit,
  });

  const nextDashboardMainQuery = {
    ...router.query, // keep existing params
    ...reformattedPrams,
    renderGroupId: "main",
  };
  const params = new URLSearchParams(
    Object.entries(nextDashboardMainQuery)
      .filter(([_, v]) => v != null && v !== "")
      .map(([k, v]) => [k, String(v)])
  );
  const url = `${pathname}?${params.toString()}`;
  return url;
}
