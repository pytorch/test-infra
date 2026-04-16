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
  enableSelectMode?: boolean;
};

// ---- Real React component with hooks (internal) ----
export default function BenchmarkTimeSeriesChartGroup({
  data,
  chartGroup,
  lcommit,
  rcommit,
  onSelect = () => {},
  enableSelectMode = true,
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
        const { key: name_key, labels: name_labels } = makeGroupKeyAndLabel(
          gi,
          chartGroup.lineKey
        );
        s.legend_name = name_labels.join(" | ");
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

  const onConfirm = (payload: any) => {
    if (onSelect) {
      onSelect(payload);
    }
  };

  return (
    <Grid container spacing={1}>
      {groups.map((g) => {
        const groupSeries = g.items.map((s) => ({ ...s }));
        const title = getBenchmarkTimeSeriesTitle(
          g.labels.join(" "),
          g.labels.join("-"),
          chartGroup?.chart
        );

        const maxTimeSeries = groupSeries
          .map((s) => s.data.length)
          .reduce((a, b) => Math.max(a, b));
        return (
          <Grid
            key={g.key}
            size={{ xs: 12, md: 12, lg: maxTimeSeries > 40 ? 12 : 6 }}
            id={toBenchmarkTimeseriesChartGroupId(g.key)}
          >
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              {title.text}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {title.description}
            </Typography>
            <BenchmarkTimeSeriesChart
              enableSelectMode={enableSelectMode}
              timeseries={groupSeries}
              customizedConfirmDialog={
                chartGroup?.chart?.customizedConfirmDialog
              }
              markArea={{
                start: lcommit?.date ?? undefined,
                end: rcommit?.date ?? undefined,
              }}
              renderOptions={chartGroup?.chart?.renderOptions}
              onSelect={onConfirm}
              legendKeys={chartGroup?.lineKey ?? []}
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
