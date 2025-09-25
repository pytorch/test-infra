import { List, ListItemButton, ListItemText } from "@mui/material";
import { DISPLAY_NAMES_TO_COMPILER_NAMES } from "components/benchmark/compilers/common";
import { highlightUntilClick } from "components/benchmark/v3/components/common/highlight";
import {
  navigateToDataGrid,
  navigateToEchartInGroup,
} from "components/benchmark/v3/components/common/navigate";
import { TimeSeriesChartDialogContentProps } from "components/benchmark/v3/components/common/SelectionDialog";
import { toToggleSectionId } from "components/benchmark/v3/components/common/ToggleSection";
import { toBenchmarkTimeseriesChartSectionId } from "components/benchmark/v3/components/dataRender/components/benchmarkTimeSeries/BenchmarkChartSection";
import { toBenchmarkTimeseriesChartGroupId } from "components/benchmark/v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChartGroup";
import { toBenchamrkTimeSeriesComparisonTableId } from "components/benchmark/v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTableSection";
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
> = ({ left, right, other, closeDialog, triggerUpdate }) => {
  if (left == null || right == null) {
    return <>Error: No data</>;
  }
  const onGoToTable = async () => {
    closeDialog();
    const cell = await navigateToDataGrid(
      toBenchamrkTimeSeriesComparisonTableId(`metric=${left.metric}`),
      [`${left?.compiler}`],
      `${left?.suite}`,
      toToggleSectionId(2)
    );
    if (cell) {
      highlightUntilClick(cell);
      triggerUpdate();
    }
  };

  const onGoToChart = async () => {
    closeDialog();

    const cell = await navigateToEchartInGroup(
      toBenchmarkTimeseriesChartSectionId(`suite=${left.suite}`),
      toBenchmarkTimeseriesChartGroupId(`metric=${left.metric}`),
      toToggleSectionId(1)
    );

    if (cell) {
      highlightUntilClick(cell);
      triggerUpdate();
    }
  };

  const onGoToUrl = () => {
    const url = toBenchmarkLegacyUrl(left, right);
    // open a new tab
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
          secondary={`Open the detailed benchmark view for suite "${left?.suite}" and compiler "${left?.compiler}" in the compiler dashboard.`}
        />
      </ListItemButton>
    </List>
  );
};

// set url to nagivate to the legacy benchmark data page
function toBenchmarkLegacyUrl(left: any, right: any) {
  // Expand the time range
  const startTime = new Date(left.granularity_bucket);
  startTime.setHours(startTime.getHours() - 6);
  const stopTime = new Date(right.granularity_bucket);
  stopTime.setHours(stopTime.getHours() + 6);

  const params: Record<string, string> = {
    dashboard: "torchinductor",
    startTime: startTime.toUTCString(), // ✅ RFC-1123 format
    stopTime: stopTime.toUTCString(),
    granularity: "hour",
    mode: left.mode,
    dtype: left.dtype,
    deviceName: `${left.device} (${left.arch})`,
    rBranch: left.branch,
    rCommit: left.commit,
    lBranch: right.branch,
    lCommit: right.commit,
  };

  // Build query string with encodeURIComponent
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `/benchmark/${left.suite}/${
    DISPLAY_NAMES_TO_COMPILER_NAMES[left.compiler]
  }?${query}`;
}
