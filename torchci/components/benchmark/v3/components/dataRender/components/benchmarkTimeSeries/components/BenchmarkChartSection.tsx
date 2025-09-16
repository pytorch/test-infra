import { Paper, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { useMemo } from "react";
import {
  BenchmarkChartSectionConfig,
  BenchmarkTimeSeriesInput,
  makeGroupKeyAndLabel,
  passesFilter,
} from "../helper";
import BenchmarkTimeSeriesChartGroup from "./BenchmarkTimeSeriesChartGroup";

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
  onChange,
}: {
  data?: BenchmarkTimeSeriesInput[];
  chartSectionConfig: BenchmarkChartSectionConfig;
  onChange?: (payload: any) => void;
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
      if (!m.has(key)) m.set(key, { key, labels, items: [] });
      m.get(key)!.items.push(s);
    }
    return m;
  }, [filtered, chartSectionConfig.groupByFields]);

  if (!data || data.length == 0) {
    return <></>;
  }

  return (
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
          <Box key={key} sx={styles.groupBox}>
            <Paper sx={styles.paper}>
              <Typography variant="h4">{title.toUpperCase()}</Typography>
              <BenchmarkTimeSeriesChartGroup
                data={data.items}
                chartGroup={chartSectionConfig.chartGroup}
                onConfirm={(payload: any) => {
                  onChange?.(payload);
                }}
              />
            </Paper>
          </Box>
        );
      })}
    </Box>
  );
}
