import { Divider, Paper, Typography } from "@mui/material";
import { Box, Grid } from "@mui/system";
import { StickyBar } from "components/benchmark/v3/components/common/StickyBar";
import { useMemo, useState } from "react";
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
  onChange,
}: {
  data?: any[];
  tableSectionConfig: BenchmarkComparisonTableSectionConfig;
  onChange?: (payload: any) => void;
}) {
  // Sticky bar offset
  const [barOffset, setBarOffset] = useState(0);
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

  const workflowMetadataInfos: any[] = useMemo(
    () => toSortedWorkflowIdMap(filtered),
    [
      filtered,
      tableSectionConfig.groupByFields,
      tableSectionConfig.filterByFieldValues,
    ]
  );

  const [lWorkflowId, setLlWorkflowId] = useState(
    workflowMetadataInfos.length > 0
      ? workflowMetadataInfos[0].workflow_id
      : null
  );
  const [rWorkflowId, setRWorkflowId] = useState(
    workflowMetadataInfos.length > 0
      ? workflowMetadataInfos[workflowMetadataInfos.length - 1].workflow_id
      : null
  );

  const onSliderChange = (next: [string, string]) => {
    setLlWorkflowId(next[0]);
    setRWorkflowId(next[1]);
  };

  if (!filtered || filtered.length == 0) {
    return <></>;
  }

  return (
    <Box sx={{ m: 1 }} key={"benchmark_time_series_comparison_section"}>
      <Typography variant="h2"> Time Series Comparison Section </Typography>
      <Divider />
      <StickyBar
        offset={barOffset}
        height={50}
        zIndex={900}
        align="left"
        contentMode="full"
        onMount={handleMount}
        onUnmount={handleUnmount}
      >
        <BenchmarkTimeSeriesComparisonTableSlider
          workflows={workflowMetadataInfos}
          onChange={onSliderChange}
        />
      </StickyBar>
      <Grid container sx={{ m: 1 }}>
        {Array.from(groupMap.entries()).map(([key, tableData]) => {
          if (!tableData) return null;
          const title = tableData.labels.join(" ");
          return (
            <Grid key={key} sx={{ p: 0.2 }} size={{ xs: 12, md: 12, lg: 6 }}>
              <Paper sx={styles.paper}>
                <Typography variant="h4">{title.toUpperCase()}</Typography>
                <Typography variant="body2">
                  {lWorkflowId} - {rWorkflowId}
                </Typography>
                <ComparisonTable
                  data={tableData.items}
                  config={tableSectionConfig.tableConfig}
                  lWorkflowId={lWorkflowId}
                  rWorkflowId={rWorkflowId}
                />
              </Paper>
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
}
