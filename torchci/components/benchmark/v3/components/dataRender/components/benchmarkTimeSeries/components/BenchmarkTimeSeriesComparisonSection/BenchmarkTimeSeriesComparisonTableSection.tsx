import { Divider, Paper, Typography } from "@mui/material";
import { Box, Grid } from "@mui/system";
import { StickyBar } from "components/benchmark/v3/components/common/StickyBar";
import { useMemo, useState } from "react";
import {
  BenchmarkComparisonTableSectionConfig,
  makeGroupKeyAndLabel,
  passesFilter,
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
  // Controlled slider range (indices)
  const [range, setRange] = useState<[number, number]>(() => {
    const n = items.length;
    return n >= 2 ? [0, n - 1] : [0, 0];
  });

  // Filter data based on the table config
  const filtered = useMemo(() => {
    if (!data) {
      return [];
    }
    return data.filter((s) =>
      passesFilter(s.group_info || {}, tableSectionConfig.filterByFieldValues)
    );
  }, [data, tableSectionConfig.filterByFieldValues]);

  // Group data based on the table config
  const groupMap = useMemo(() => {
    const m = new Map<string, { key: string; labels: string[]; items: any }>();
    for (const s of filtered) {
      const gi = s.group_info || {};
      const { key, labels } = makeGroupKeyAndLabel(
        gi,
        tableSectionConfig.groupByFields
      );
      if (!m.has(key)) m.set(key, { key, labels, items: [] });
      m.get(key)!.items.push(s);
    }
    return m;
  }, [filtered, tableSectionConfig.groupByFields]);

  // Build a list of workflows for the slider (you can add labels/timestamps here)
  const items: any[] = useMemo(() => {
    const idMap = new Map<string, any>();
    for (const d of filtered) {
      const id = String(d.group_info.workflow_id);
      const commit = String(d.group_info.commit);
      idMap.set(id, {
        workflow_id: id,
        label: id,
        commit: commit, // keep previous commit if any
        branch: d.group_info.branch,
      });
    }
    return Array.from(idMap.values());
  }, [
    filtered,
    tableSectionConfig.groupByFields,
    tableSectionConfig.filterByFieldValues,
  ]);

  if (!data || data.length == 0) {
    return <></>;
  }

  // Derive L/R workflow IDs from the range
  const sortedIds = useMemo(
    () =>
      items
        .map((i) => i.workflow_id)
        .sort((a, b) => {
          const na = /^\d+$/.test(a) ? Number(a) : NaN;
          const nb = /^\d+$/.test(b) ? Number(b) : NaN;
          return Number.isNaN(na) || Number.isNaN(nb)
            ? a.localeCompare(b)
            : na - nb;
        }),
    [items]
  );

  const lWorkflowId = sortedIds[range[0]] ?? null;
  const rWorkflowId = sortedIds[range[1]] ?? null;

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
          items={items}
          range={range}
          onChange={setRange}
        />
      </StickyBar>
      <Grid container sx={{ m: 1 }}>
        {Array.from(groupMap.entries()).map(([key, data]) => {
          if (!data) return null;
          const title = data.labels.join(" ");
          return (
            <Grid key={key} sx={{ p: 0.2 }} size={{ xs: 12, md: 12, lg: 6 }}>
              <Paper sx={styles.paper}>
                <Typography variant="h4">{title.toUpperCase()}</Typography>
                <Typography variant="body2">
                  {lWorkflowId} - {rWorkflowId}
                </Typography>
                <ComparisonTable
                  data={data.items}
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
