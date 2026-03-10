import { Paper } from "@mui/material";
import { Box, Grid, Stack } from "@mui/system";
import { StickyBar } from "components/benchmark_v3/components/common/StickyBar";
import { UMDenseButtonLight } from "components/uiModules/UMDenseComponents";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useEffect, useMemo, useState } from "react";
import {
  BenchmarkComparisonTableSectionConfig,
  getBenchmarkTimeSeriesTitle,
  passesFilter,
  toGroupKeyMap,
  toSortedWorkflowIdMap,
} from "../../helper";
import { ComparisonTable } from "./BenchmarkTimeSeriesComparisonTable/ComparisonTable";
import { BenchmarkTimeSeriesComparisonTableSlider } from "./BenchmarkTimeSeriesComparisonTableSlider";
import { BenchmarkTimeSeriesSingleSlider } from "./BenchmarkTimeSeriesSingleSlider";

const styles = {
  container: {
    flexGrow: 1,
  },
  paper: {
    p: 2,
    elevation: 2,
    borderRadius: 2,
  },
};

export default function BenchmarkTimeSeriesComparisonTableSection({
  data = [],
  tableSectionConfig,
  lcommit,
  rcommit,
  onChange,
  enableMultiBranchOption = false,
}: {
  data?: any[];
  tableSectionConfig: BenchmarkComparisonTableSectionConfig;
  lcommit?: BenchmarkCommitMeta;
  rcommit?: BenchmarkCommitMeta;
  onChange?: (payload: any) => void;
  enableMultiBranchOption?: boolean;
}) {
  const { setLcommit, setRcommit, committedLbranch, committedRbranch } =
    useDashboardSelector((s) => ({
      setLcommit: s.setLcommit,
      setRcommit: s.setRcommit,
      committedLbranch: s.committedLbranch,
      committedRbranch: s.committedRbranch,
    }));

  // Sticky bar offset - need more offset for multi-branch mode with two sliders
  const isMultiBranchMode =
    enableMultiBranchOption && committedLbranch !== committedRbranch;

  // Height for sticky bar - two sliders need more height
  const stickyBarHeight = isMultiBranchMode ? 100 : 50;

  const [barOffset, setBarOffset] = useState(75);
  const handleMount = (h: number) => setBarOffset((prev) => prev + h);
  const handleUnmount = (h: number) => setBarOffset((prev) => prev - h);

  // Filter data based on the table config
  const filtered = useMemo(() => {
    if (!data) return [];
    return data.filter((s) =>
      passesFilter(s.group_info || {}, tableSectionConfig.filterByFieldValues)
    );
  }, [data, tableSectionConfig.filterByFieldValues]);

  // Group data based on the table config
  const groupMap = useMemo(
    () => toGroupKeyMap(filtered, tableSectionConfig.groupByFields),
    [filtered, tableSectionConfig.groupByFields]
  );

  // For multi-branch mode, separate workflows by branch
  const { lWorkflowInfos, rWorkflowInfos, workflowInfos } = useMemo(() => {
    const allWorkflows = toSortedWorkflowIdMap(filtered);

    if (enableMultiBranchOption && committedLbranch !== committedRbranch) {
      const lWorkflows = allWorkflows.filter(
        (w) => w.branch === committedLbranch
      );
      const rWorkflows = allWorkflows.filter(
        (w) => w.branch === committedRbranch
      );
      return {
        lWorkflowInfos: lWorkflows,
        rWorkflowInfos: rWorkflows,
        workflowInfos: allWorkflows,
      };
    }

    return {
      lWorkflowInfos: allWorkflows,
      rWorkflowInfos: allWorkflows,
      workflowInfos: allWorkflows,
    };
  }, [filtered, enableMultiBranchOption, committedLbranch, committedRbranch]);

  const [lWorkflowId, setLWorkflowId] = useState(
    lWorkflowInfos.length > 0 ? lWorkflowInfos[0].workflow_id : null
  );
  const [rWorkflowId, setRWorkflowId] = useState(
    rWorkflowInfos.length > 0
      ? rWorkflowInfos[rWorkflowInfos.length - 1].workflow_id
      : null
  );

  useEffect(() => {
    if (!lcommit || !rcommit) return;
    setLWorkflowId(lcommit?.workflow_id);
    setRWorkflowId(rcommit?.workflow_id);
  }, [lcommit, rcommit]);

  // Update workflow IDs when branch filtering changes
  useEffect(() => {
    if (enableMultiBranchOption && committedLbranch !== committedRbranch) {
      if (lWorkflowInfos.length > 0) {
        const currentLExists = lWorkflowInfos.some(
          (w) => w.workflow_id === lWorkflowId
        );
        if (!currentLExists) {
          setLWorkflowId(lWorkflowInfos[0].workflow_id);
        }
      }
      if (rWorkflowInfos.length > 0) {
        const currentRExists = rWorkflowInfos.some(
          (w) => w.workflow_id === rWorkflowId
        );
        if (!currentRExists) {
          setRWorkflowId(rWorkflowInfos[rWorkflowInfos.length - 1].workflow_id);
        }
      }
    }
  }, [
    enableMultiBranchOption,
    committedLbranch,
    committedRbranch,
    lWorkflowInfos,
    rWorkflowInfos,
  ]);

  const onSliderChange = (next: [string, string]) => {
    setLWorkflowId(next[0]);
    setRWorkflowId(next[1]);
  };

  const onLSliderChange = (next: string) => {
    setLWorkflowId(next);
  };

  const onRSliderChange = (next: string) => {
    setRWorkflowId(next);
  };

  const dynamicSize = {
    xs: 12,
    md: 12,
    lg: 6,
    ...tableSectionConfig?.renderOptions?.dynamicSize,
  };

  if (!filtered || filtered.length == 0) {
    return <></>;
  }

  const onClickUpdate = () => {
    const lInfo = workflowInfos.find((w) => w.workflow_id === lWorkflowId);
    const rInfo = workflowInfos.find((w) => w.workflow_id === rWorkflowId);
    if (!lInfo || !rInfo) return;
    setLcommit(lInfo);
    setRcommit(rInfo);
  };

  return (
    <>
      <Box sx={{ m: 1 }} key={"benchmark_time_series_comparison_section"}>
        <StickyBar
          offset={barOffset}
          height={stickyBarHeight}
          zIndex={900}
          align="left"
          contentMode="full"
          onMount={handleMount}
          onUnmount={handleUnmount}
          rootMargin="-200px 0px 0px 0px"
        >
          <Paper sx={{ p: 2, width: "100%" }}>
            <Stack
              spacing={2}
              direction="column"
              sx={{ width: "100%" }}
              alignItems={"flex-start"}
            >
              {isMultiBranchMode ? (
                <Box sx={{ width: "100%" }}>
                  <BenchmarkTimeSeriesSingleSlider
                    workflows={lWorkflowInfos}
                    onChange={onLSliderChange}
                    selectedWorkflowId={lWorkflowId ?? undefined}
                    label={`L (${committedLbranch})`}
                  />
                  <BenchmarkTimeSeriesSingleSlider
                    workflows={rWorkflowInfos}
                    onChange={onRSliderChange}
                    selectedWorkflowId={rWorkflowId ?? undefined}
                    label={`R (${committedRbranch})`}
                  />
                </Box>
              ) : (
                <BenchmarkTimeSeriesComparisonTableSlider
                  workflows={workflowInfos}
                  onChange={onSliderChange}
                  lWorkflowId={lWorkflowId ?? undefined}
                  rWorkflowId={rWorkflowId ?? undefined}
                />
              )}
              <UMDenseButtonLight onClick={onClickUpdate}>
                Update
              </UMDenseButtonLight>
            </Stack>
          </Paper>
        </StickyBar>
        <Grid container sx={{ m: 1 }}>
          {Array.from(groupMap.entries()).map(([key, tableData]) => {
            if (!tableData) return null;
            const default_title = tableData.labels.join(" ");
            const k = tableData.labels.join("-");
            const title = getBenchmarkTimeSeriesTitle(
              default_title,
              k,
              tableSectionConfig.tableConfig
            );
            return (
              <Grid
                key={key}
                sx={{ p: 0.2 }}
                size={dynamicSize}
                id={`benchmark-time-series-comparison-table-${key}`}
              >
                <Paper sx={styles.paper}>
                  <ComparisonTable
                    data={tableData.items}
                    config={tableSectionConfig.tableConfig}
                    lWorkflowId={lWorkflowId}
                    rWorkflowId={rWorkflowId}
                    title={title}
                    onSelect={onChange}
                  />
                </Paper>
              </Grid>
            );
          })}
        </Grid>
      </Box>
    </>
  );
}

export function toBenchamrkTimeSeriesComparisonTableId(key: string) {
  return `benchmark-time-series-comparison-table-${key}`;
}
