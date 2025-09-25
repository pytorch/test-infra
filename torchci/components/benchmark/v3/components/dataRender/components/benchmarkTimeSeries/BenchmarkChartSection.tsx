import { Paper, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useMemo } from "react";
import BenchmarkTimeSeriesChartGroup from "./components/BenchmarkTimeSeriesChartGroup";
import {
  BenchmarkChartSectionConfig,
  BenchmarkTimeSeriesInput,
  makeGroupKeyAndLabel,
  passesFilter,
} from "./helper";

const styles = {
  container: {
    flexGrow: 1,
  },
  groupBox: {
    margin: 1,
  },
  paper: {
    p: 2,
    elevation: 2,
    borderRadius: 2,
  },
};

export default function BenchmarkChartSection({
  data = [],
  chartSectionConfig,
  onSelect,
}: {
  data?: BenchmarkTimeSeriesInput[];
  chartSectionConfig: BenchmarkChartSectionConfig;
  lcommit?: BenchmarkCommitMeta;
  rcommit?: BenchmarkCommitMeta;
  onSelect?: (payload: any) => void;
}) {
  const filtered = useMemo(() => {
    if (!data) {
      return [];
    }
    return data.filter((s) =>
      passesFilter(s.group_info || {}, chartSectionConfig.filterByFieldValues)
    );
  }, [data, chartSectionConfig.filterByFieldValues]);

  const groupMap = useMemo(() => {
    const m = new Map<
      string,
      { key: string; labels: string[]; items: BenchmarkTimeSeriesInput[] }
    >();
    for (const s of filtered) {
      const gi = s.group_info || {};
      const { key, labels } = makeGroupKeyAndLabel(
        gi,
        chartSectionConfig.groupByFields
      );
      if (!m.has(key)) {
        m.set(key, { key, labels, items: [] });
      }
      m.get(key)!.items.push(s);
    }
    return m;
  }, [filtered, chartSectionConfig.groupByFields]);

  if (!data || data.length == 0) {
    return <></>;
  }

  return (
    <Box sx={{ m: 1 }}>
      <Box sx={styles.container}>
        {Array.from(groupMap.entries()).map(([key, data]) => {
          if (!data) return null;
          const op = chartSectionConfig.chartGroup?.renderOptions;
          const title = data.labels.join(" ");

          let renderOptions = chartSectionConfig.chartGroup?.renderOptions;
          if (op && op.pass_section_title) {
            renderOptions = {
              ...renderOptions,
              titleSuffix: `/${title}`,
            };
          }
          return (
            <Box
              key={key}
              sx={styles.groupBox}
              id={toBenchmarkTimeseriesChartSectionId(key)}
            >
              <Paper sx={styles.paper}>
                <Typography variant="h6">{title.toUpperCase()}</Typography>
                <BenchmarkTimeSeriesChartGroup
                  data={data.items}
                  chartGroup={chartSectionConfig.chartGroup}
                  onSelect={(payload: any) => {
                    onSelect?.(payload);
                  }}
                />
              </Paper>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export function toBenchmarkTimeseriesChartSectionId(key: string) {
  return `benchmark-time-series-chart-section-${key}`;
}
