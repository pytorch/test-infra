import CircleIcon from "@mui/icons-material/Circle";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Chip, IconButton, Tooltip, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { getBenchmarkFields } from "components/benchmark_v3/configs/helpers/utils/urlHandling";
import { getBenchmarkMainRouteById } from "components/benchmark_v3/pages/BenchmarkListPage";
import { queryObjectToSearchParams } from "components/uiModules/UMCopyLink";
import dayjs from "dayjs";
import {
  BenchmarkCommitMeta,
  getBenchmarkIdFromReportId,
  TimeRange,
} from "lib/benchmark/store/benchmark_regression_store";
import { stateToQuery } from "lib/helpers/urlQuery";

/**
 * Benchmark regression report data model in UI
 */
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
//

/**
 * Color map for regression status
 */
export const STATUS_COLOR_MAP: Record<string, string> = {
  no_regression: "#2e7d32", // success.main
  regression: "#d32f2f", // error.main
  suspicious: "#ed6c02", // warning.main
  insufficient_data: "rgba(0, 0, 0, 0.6)", // text.secondary (grey)
};

export const BenchmarkNotificationColor: Record<string, string> = {
  warning: "#ed6c02", // warning.main
  error: "#d32f2f", // error.main
};

/**
 * Default colors for baseline and regression indicators for regression report charts.
 */
export const DEFAULT_BASELINE_COLOR = "green";
export const DEFAULT_REGRESSION_COLOR = "red";

/**
 * Common component to render regression bucket counts from regression report
 */
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

/**
 * Common component to render key-value info in list of chips.
 * main use case is to render group info in benchmark.
 */
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

/**
 *
 * Common component to render regression report chart indicators used in regression report charts.
 */
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

/**
 *
 * Build url to navigate to v3 main benchmark page using report_id
 */
export function getNavigationRouteByReportId(
  report_id: string,
  group_info: any,
  startCommit: any,
  endCommit: any
): string {
  if (!startCommit || !endCommit) {
    console.warn(
      "cannot navigate to v3 main page, missing commit info, currently have:",
      startCommit,
      endCommit
    );
    return "";
  }

  const id = getBenchmarkIdFromReportId(report_id);
  if (!id) {
    console.warn(
      "cannot navigate to v3 main page, missing benchmark id using report id: ",
      report_id
    );
    return "";
  }

  const route = getBenchmarkMainRouteById(id);
  if (!route) {
    return "";
  }

  const time: TimeRange = {
    start: dayjs(startCommit?.timestamp).startOf("day"),
    end: dayjs(endCommit?.timestamp).endOf("day"),
  };

  const fields = getBenchmarkFields(group_info, id);

  const lcommit: BenchmarkCommitMeta = {
    commit: startCommit?.commit,
    branch: startCommit?.branch,
    workflow_id: startCommit?.workflow_id,
    date: startCommit?.timestamp,
  };

  const rcommit: BenchmarkCommitMeta = {
    commit: endCommit.commit,
    branch: endCommit.branch,
    workflow_id: endCommit.workflow_id,
    date: endCommit.timestamp,
  };
  const branch = startCommit.branch;

  const params = {
    rcommit: rcommit,
    lcommit: lcommit,
    time: time,
    filters: fields,
    lbranch: branch,
    rbranch: branch,
  };

  const finalRoute = formUrlWithParams(route, params);

  return finalRoute;
}

/**
 * Dynamically build url with params
 * @param url
 * @param params
 * @param excludeKeys
 * @returns
 */
export function formUrlWithParams(url: string, params: any, excludeKeys = []) {
  const paramsString = queryObjectToSearchParams(
    stateToQuery(params, excludeKeys)
  );
  return `${url}?${paramsString}`;
}

export function ReportPageToV3MainPageNavigationButton({
  report_id,
  group_info,
  startCommit,
  endCommit,
}: {
  report_id: string;
  group_info: any;
  startCommit: any;
  endCommit: any;
}) {
  const id = getBenchmarkIdFromReportId(report_id);
  if (!id) {
    console.warn(
      "cannot navigate to v3 main page, missing benchmark id using report id: ",
      report_id
    );
    return null;
  }
  const route = getBenchmarkMainRouteById(id);

  const url = getNavigationRouteByReportId(
    report_id,
    group_info,
    startCommit,
    endCommit
  );

  let tooltipContent = `Investigate in main page: ${route}`;
  let disableButton = false;

  if (!url || !route) {
    tooltipContent = `Cannot navigate to main page, missing url or route info.
     Please report this issue to pytorch infra team. You can still view the chart sidepanel in this page.`;
    disableButton = true;
  }
  return (
    <Tooltip title={tooltipContent}>
      <IconButton
        component="a"
        href={url}
        onClick={(e) => {
          if (disableButton) {
            return;
          }
          e.stopPropagation();
        }}
      >
        <OpenInNewIcon fontSize="small" color="primary" />
      </IconButton>
    </Tooltip>
  );
}
