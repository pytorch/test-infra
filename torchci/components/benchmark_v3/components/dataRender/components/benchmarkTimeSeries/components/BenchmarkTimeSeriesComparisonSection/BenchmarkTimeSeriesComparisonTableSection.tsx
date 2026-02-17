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
import { table } from "console";

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
}: {
  data?: any[];
  tableSectionConfig: BenchmarkComparisonTableSectionConfig;
  lcommit?: BenchmarkCommitMeta;
  rcommit?: BenchmarkCommitMeta;
  onChange?: (payload: any) => void;
}) {
  const { setLcommit, setRcommit } = useDashboardSelector((s) => ({
    setLcommit: s.setLcommit,
    setRcommit: s.setRcommit,
  }));

  // Sticky bar offset
  const [barOffset, setBarOffset] = useState(70);
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

  const workflowInfos: any[] = useMemo(
    () => toSortedWorkflowIdMap(filtered),
    [
      filtered,
      tableSectionConfig.groupByFields,
      tableSectionConfig.filterByFieldValues,
    ]
  );

  const [lWorkflowId, setLlWorkflowId] = useState(
    workflowInfos.length > 0 ? workflowInfos[0].workflow_id : null
  );
  const [rWorkflowId, setRWorkflowId] = useState(
    workflowInfos.length > 0
      ? workflowInfos[workflowInfos.length - 1].workflow_id
      : null
  );

  useEffect(() => {
    if (!lcommit || !rcommit) return;
    setLlWorkflowId(lcommit?.workflow_id);
    setRWorkflowId(rcommit?.workflow_id);
  }, [lcommit, rcommit]);

  const onSliderChange = (next: [string, string]) => {
    setLlWorkflowId(next[0]);
    setRWorkflowId(next[1]);
  };

  const dynamicSize = {
    xs: 12,
    md: 12,
    lg: 6,
    ...tableSectionConfig?.renderOptions?.dynamicSize
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
              direction="row"
              sx={{ width: "100%" }}
              alignItems={"flex-start"}
            >
              <BenchmarkTimeSeriesComparisonTableSlider
                workflows={workflowInfos}
                onChange={onSliderChange}
                lWorkflowId={lWorkflowId}
                rWorkflowId={rWorkflowId}
              />
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
