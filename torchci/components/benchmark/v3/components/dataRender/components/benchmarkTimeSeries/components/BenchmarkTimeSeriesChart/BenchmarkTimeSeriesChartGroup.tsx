import { Grid, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useMemo } from "react";
import {
  BenchmarkTimeSeriesInput,
  ChartGroupConfig,
  getBenchmarkTimeSeriesTitle,
  makeGroupKeyAndLabel,
  passesFilter,
} from "../../helper";
import BenchmarkTimeSeriesChart from "./BenchmarkTimeSeriesChart";

type Props = {
  data: any[];
  chartGroup: ChartGroupConfig;
  defaultSelectMode?: boolean;
  lcommit?: BenchmarkCommitMeta;
  rcommit?: BenchmarkCommitMeta;
  onSelect?: (payload: any) => void;
};

// ---- Real React component with hooks (internal) ----
export default function BenchmarkTimeSeriesChartGroup({
  data,
  chartGroup,
  defaultSelectMode = false,
  lcommit,
  rcommit,
  onSelect = () => {},
}: Props) {
  const filtered = useMemo(
    () =>
      data.filter((s) =>
        passesFilter(s.group_info || {}, chartGroup.filterByFieldValues)
      ),
    [data, chartGroup.filterByFieldValues]
  );
  const groups = useMemo(() => {
    const m = new Map<
      string,
      { labels: string[]; items: BenchmarkTimeSeriesInput[] }
    >();
    for (const s of filtered) {
      const gi = s.group_info || {};
      const gbf = chartGroup.groupByFields ?? [];
      const { key, labels } = makeGroupKeyAndLabel(gi, gbf);
      if (!m.has(key)) m.set(key, { labels, items: [] });
      if (chartGroup.lineKey) {
        const { key: _, labels: name_labels } = makeGroupKeyAndLabel(
          gi,
          chartGroup.lineKey
        );
        s.legend_name = name_labels.join("|");
      }
      m.get(key)!.items.push(s);
    }
    return Array.from(m.entries()).map(([key, { labels, items }]) => ({
      key,
      labels,
      items,
    }));
  }, [filtered, chartGroup.groupByFields]);

  if (groups.length === 0) {
    return (
      <Box>
        <Typography variant="body2" color="text.secondary">
          No data after filter.
        </Typography>
      </Box>
    );
  }

  return (
    <Grid container spacing={1}>
      {groups.map((g) => {
        const groupSeries = g.items.map((s) => ({ ...s }));
        const title = getBenchmarkTimeSeriesTitle(
          g.labels.join(" "),
          g.labels.join("-"),
          chartGroup?.chart
        );
        return (
          <Grid
            key={g.key}
            size={{ xs: 12, md: 12, lg: 6 }}
            id={toBenchmarkTimeseriesChartGroupId(g.key)}
          >
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              {title.text}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {title.description}
            </Typography>
            <BenchmarkTimeSeriesChart
              timeseries={groupSeries}
              customizedConfirmDialog={
                chartGroup?.chart?.customizedConfirmDialog
              }
              markArea={{
                start: lcommit?.date ?? undefined,
                end: rcommit?.date ?? undefined,
              }}
              renderOptions={chartGroup?.chart?.renderOptions}
              defaultSelectMode={defaultSelectMode}
              onSelect={onSelect}
            />
          </Grid>
        );
      })}
    </Grid>
  );
}

export function toBenchmarkTimeseriesChartGroupId(key: string) {
  return `benchmark-time-series-chart-group-${key}`;
}
