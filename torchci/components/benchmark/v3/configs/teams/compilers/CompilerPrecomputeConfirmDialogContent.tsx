import { List, ListItemButton, ListItemText } from "@mui/material";
import { DISPLAY_NAMES_TO_COMPILER_NAMES } from "components/benchmark/compilers/common";
import { highlightUntilClick } from "components/benchmark/v3/components/common/highlight";
import {
  navigateToDataGrid,
  navigateToEchartInGroup,
} from "components/benchmark/v3/components/common/navigate";
import { TimeSeriesChartDialogContentProps } from "components/benchmark/v3/components/common/SelectionDialog";
/**
 * Customized dialog content for compiler precompute benchmark page.
 * if parent is timeSeriesChart, we will show the following options:
 *  1. Navigate to the time series comparison table section on this page.
 *  2. Navigate to the legacy benchmark data page.
 *
 * if parent is comparisonTable, we will show the following options:
 * 1. Navigate to the time series chart section on this page.
 * 2. Navigate to the legacy benchmark data page.
 *
 * the option 2 will be replaced by new raw data page in the future.
 * @returns
 */
export const CompilerPrecomputeConfirmDialogContent: React.FC<
  TimeSeriesChartDialogContentProps
> = ({ leftMeta, rightMeta, other, closeDialog, triggerUpdate }) => {
  if (leftMeta == null || rightMeta == null) {
    return <>Error: No data</>;
  }
  const onGoToTable = () => {
    const cell = navigateToDataGrid(
      `benchmark-time-series-comparison-table-metric=${leftMeta.metric}`,
      [`${leftMeta?.compiler}`],
      `${leftMeta?.suite}`
    );
    if (cell) {
      highlightUntilClick(cell);
      closeDialog();
      triggerUpdate(true);
    }
  };

  const onGoToChart = () => {
    const cell = navigateToEchartInGroup(
      `benchmark-time-series-chart-section-suite=${leftMeta.suite}`,
      `benchmark-time-series-chart-group-metric=${leftMeta.metric}`
    );

    if (cell) {
      highlightUntilClick(cell);
      closeDialog();
      triggerUpdate(true);
    }
  };

  const onGoToUrl = () => {
    const url = toBenchmarkLegacyUrl(leftMeta, rightMeta);
    window.open(url, "_blank");
  };
  return (
    <List>
      {other?.parent === "timeSeriesChart" && (
        <ListItemButton onClick={onGoToTable}>
          <ListItemText
            primary="Navigate to comparison table"
            secondary="Jump to the time series comparison table section on this page."
          />
        </ListItemButton>
      )}
      {other?.parent === "comparisonTable" && (
        <ListItemButton onClick={onGoToChart}>
          <ListItemText
            primary="Navigate to time series chart"
            secondary="Jump to the time series comparison table section on this page."
          />
        </ListItemButton>
      )}
      <ListItemButton onClick={onGoToUrl}>
        <ListItemText
          primary="Navigate to detail view"
          secondary={`Open the detailed benchmark view for suite "${leftMeta?.suite}" and compiler "${leftMeta?.compiler}" in the compiler dashboard.`}
        />
      </ListItemButton>
    </List>
  );
};

// set url to nagivate to the legacy benchmark data page
function toBenchmarkLegacyUrl(leftMeta: any, rightMeta: any) {
  // Expand the time range
  const startTime = new Date(leftMeta.granularity_bucket);
  startTime.setHours(startTime.getHours() - 6);
  const stopTime = new Date(rightMeta.granularity_bucket);
  stopTime.setHours(stopTime.getHours() + 6);

  const params: Record<string, string> = {
    dashboard: "torchinductor",
    startTime: startTime.toUTCString(), // ✅ RFC-1123 format
    stopTime: stopTime.toUTCString(),
    granularity: "hour",
    mode: leftMeta.mode,
    dtype: leftMeta.dtype,
    deviceName: `${leftMeta.device} (${leftMeta.arch})`,
    rBranch: leftMeta.branch,
    rCommit: leftMeta.commit,
    lBranch: rightMeta.branch,
    lCommit: rightMeta.commit,
  };

  // Build query string with encodeURIComponent
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `/benchmark/${leftMeta.suite}/${DISPLAY_NAMES_TO_COMPILER_NAMES[leftMeta.compiler]}?${query}`;
}
