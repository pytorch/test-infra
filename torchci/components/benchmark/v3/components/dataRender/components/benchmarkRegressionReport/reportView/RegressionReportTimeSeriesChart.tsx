import { Divider, Paper, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { StaticRenderViewOnlyContent } from "components/benchmark/v3/components/common/StaticRenderViewOnlyContent";
import BenchmarkTimeSeriesChart from "components/benchmark/v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeSeriesChart";
import {
  BenchmarkTimeSeriesInput,
  RawTimeSeriesPoint,
} from "components/benchmark/v3/components/dataRender/components/benchmarkTimeSeries/helper";
import {
  DEFAULT_BASELINE_COLOR,
  DEFAULT_REGRESSION_COLOR,
  GroupInfoChips,
  RegressionReportChartIndicatorsSection,
} from "../common";

export function ReportTimeSereisChartSection({
  item,
  subtitle = "",
  id,
  hidePolicy = false,
  hideBaseline = false,
  hideChips = false,
  enableSelectMode = false,
  enableIndicator = false,
}: {
  item: any;
  subtitle: string;
  id?: string;
  hidePolicy?: boolean;
  hideBaseline?: boolean;
  hideChips?: boolean;
  enableSelectMode?: boolean;
  enableIndicator?: boolean;
}) {
  const group_info = item?.group_info ?? {};
  const tsData = toTimeSeriesData(item);
  const baseline = item?.baseline_point;
  return (
    <Paper id={id} variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.25}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {subtitle}
        </Typography>
        {!hideChips && (
          <GroupInfoChips info={group_info} chipSx={{ fontSize: 10 }} />
        )}
        <Box sx={{ mt: 0.5 }}>
          <BenchmarkTimeSeriesChart
            timeseries={tsData}
            enableSelectMode={enableSelectMode}
          />
        </Box>
        <Divider />
          {enableIndicator && (
            <>
            <RegressionReportChartIndicatorsSection />
            <Divider />
            </>
            )}

        {!hidePolicy && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Policy: how we detect the regression based on baseline point
            </Typography>
            <StaticRenderViewOnlyContent
              data={item.policy}
              title=""
              maxDepth={10}
            />
          </Box>
        )}
        {!hideBaseline && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Baseline Point: the point we use as baseline to detect the
              regression
            </Typography>
            <StaticRenderViewOnlyContent
              data={baseline}
              title=""
              maxDepth={10}
            />
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

// Converts the regression report data to a format that can be used by the benchmark time series chart
function toTimeSeriesData(data: any): BenchmarkTimeSeriesInput[] {
  let res: BenchmarkTimeSeriesInput[] = [];
  const group_info = data?.group_info ?? {};
  const baseline = data?.baseline_point;
  const allBaslinepoints = data?.all_baseline_points;

  const points = data?.points;
  const all = [...allBaslinepoints, ...points].map((item) => {
    let res = toRawTimeSeriesPoint(item, group_info);
    if (item?.workflow_id === baseline?.workflow_id) {
      res = {
        ...res,
        renderOptions: {
          size: 15,
          color: DEFAULT_BASELINE_COLOR,
        },
      };
    }
    if (item?.flag === true) {
      res = {
        ...res,
        renderOptions: {
          size: 10,
          color: DEFAULT_REGRESSION_COLOR,
        },
      };
    }
    return res;
  });

  res.push({
    group_info,
    legend_name: group_info?.metric ?? "unknown",
    data: all,
  });
  return res;
}

function toRawTimeSeriesPoint(data: any, group_info: any): RawTimeSeriesPoint {
  const ts = data?.timestamp;
  return {
    ...data,
    group_info,
    metric: group_info?.metric ?? "unknown",
    granularity_bucket: ts,
  };
}
