import CircleIcon from "@mui/icons-material/Circle";
import { Chip, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";

export interface BenchmarkRegressionReport {
  id: string;
  report_id: string;
  created_at: string;
  last_record_ts: string;
  stamp: string;
  last_record_commit: string;
  type: string;
  status: string;
  regression_count: number;
  insufficient_data_count: number;
  suspected_regression_count: number;
  total_count: number;
  repo: string;
  policy?: any;
  details?: any;
}

export const STATUS_COLOR_MAP: Record<string, string> = {
  no_regression: "#2e7d32", // success.main
  regression: "#d32f2f", // error.main
  suspicious: "#ed6c02", // warning.main
  insufficient_data: "rgba(0, 0, 0, 0.6)", // text.secondary (grey)
};

export function BenchmarkRegressionBucketCounts({
  report,
  sx,
}: {
  report: BenchmarkRegressionReport;
  sx?: any;
}) {
  const renderStatus = (
    label: string,
    value?: number,
    key?: keyof typeof STATUS_COLOR_MAP,
    sx?: any
  ) => {
    const color =
      value && value > 0 && key
        ? STATUS_COLOR_MAP[key] ?? undefined
        : undefined;

    return (
      <Typography variant="body2" sx={{ color, ...sx }}>
        {label}: <strong>{value ?? 0}</strong>
      </Typography>
    );
  };

  return (
    <Box sx={sx}>
      <Stack direction="row" spacing={2} flexWrap="wrap">
        {renderStatus("Regression", report?.regression_count, "regression")}
        {renderStatus(
          "Suspected",
          report?.suspected_regression_count,
          "suspicious"
        )}
        {renderStatus(
          "Insufficient",
          report?.insufficient_data_count,
          "insufficient_data"
        )}
        <Typography variant="body2">Total: {report?.total_count}</Typography>
      </Stack>
    </Box>
  );
}

export const DEFAULT_BASELINE_COLOR = "green";
export const DEFAULT_REGRESSION_COLOR = "red";

export function GroupInfoChips({
  info,
  chipSx,
}: {
  info: Record<string, any>;
  chipSx?: any;
}) {
  const entries = Object.entries(info ?? {});
  if (!entries.length) return null;
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" gap={0.5}>
      {entries.map(([k, v]) => (
        <Chip
          key={k}
          size="small"
          sx={{ mb: 0.5, borderRadius: 1, ...chipSx }}
          label={
            <span>
              <strong>{k}</strong>: {String(v)}
            </span>
          }
        />
      ))}
    </Stack>
  );
}

export function RegressionReportChartIndicatorsSection() {
  return (
    <Box>
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        Indicators:
      </Typography>
      <Stack direction="row" spacing={1.5} flexWrap="wrap">
        <RenderIndicator
          title="Baseline"
          color={DEFAULT_BASELINE_COLOR} // DEFAULT_BASELINE_COLOR
          description="The point used as baseline to detect regressions."
        />
        <RenderIndicator
          title="Regression"
          color={DEFAULT_REGRESSION_COLOR} // DEFAULT_REGRESSION_COLOR
          description="The point detected as regression."
        />
      </Stack>
    </Box>
  );
}

function RenderIndicator({
  title,
  color,
  description,
}: {
  title: string;
  color: string;
  description?: string;
}) {
  return (
    <Box>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {title}
        </Typography>
        <CircleIcon
          fontSize="small"
          sx={{ color: color, verticalAlign: "middle" }}
        />
      </Stack>
      <Typography variant="caption" sx={{ mb: 0.5 }}>
        {description}
      </Typography>
    </Box>
  );
}
