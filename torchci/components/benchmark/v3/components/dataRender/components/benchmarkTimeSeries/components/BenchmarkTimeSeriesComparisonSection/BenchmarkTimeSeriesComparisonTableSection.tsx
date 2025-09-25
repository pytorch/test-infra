import { Paper } from "@mui/material";
import { Box, Grid } from "@mui/system";
import { StickyBar } from "components/benchmark/v3/components/common/StickyBar";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useEffect, useMemo, useState } from "react";
import {
  BenchmarkComparisonTableSectionConfig,
  passesFilter,
  toGroupKeyMap,
  toSortedWorkflowIdMap,
} from "../../helper";
import { ComparisonTable } from "./BenchmarkTimeSeriesComparisonTable/ComparisonTable";
import { BenchmarkTimeSeriesComparisonTableSlider } from "./BenchmarkTimeSeriesComparisonTableSlider";

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
  // Sticky bar offset
  const [barOffset, setBarOffset] = useState(-20);
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

  if (!filtered || filtered.length == 0) {
    return <></>;
  }

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
        >
          <BenchmarkTimeSeriesComparisonTableSlider
            workflows={workflowInfos}
            onChange={onSliderChange}
            lWorkflowId={lWorkflowId}
            rWorkflowId={rWorkflowId}
          />
        </StickyBar>
        <Grid container sx={{ m: 1 }}>
          {Array.from(groupMap.entries()).map(([key, tableData]) => {
            if (!tableData) return null;
            const title = tableData.labels.join(" ");
            return (
              <Grid
                key={key}
                sx={{ p: 0.2 }}
                size={{ xs: 12, md: 12, lg: 6 }}
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
