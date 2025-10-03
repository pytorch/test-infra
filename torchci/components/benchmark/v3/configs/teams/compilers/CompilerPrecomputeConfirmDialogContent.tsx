import { List } from "@mui/material";
import { Box } from "@mui/system";
import { DISPLAY_NAMES_TO_COMPILER_NAMES } from "components/benchmark/compilers/common";
import { highlightUntilClick } from "components/benchmark/v3/components/common/highlight";
import {
  getElementById,
  navigateToDataGrid,
  navigateToEchartInGroup,
  scrollingToElement,
} from "components/benchmark/v3/components/common/navigate";
import { TimeSeriesChartDialogContentProps } from "components/benchmark/v3/components/common/SelectionDialog";
import { NavListItem } from "components/benchmark/v3/components/common/styledComponents";
import { toToggleSectionId } from "components/benchmark/v3/components/common/ToggleSection";
import { toBenchmarkTimeseriesChartGroupId } from "components/benchmark/v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeSeriesChartGroup";
import { toBenchmarkTimeseriesChartSectionId } from "components/benchmark/v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeSeriesChartSection";
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
    return (
      <Box>
        Can&apos;t provide options whent at least one value (left|right) is
        missing
      </Box>
    );
  }
  const onGoToTable = async () => {
    closeDialog();
    const toggleSectonId = toToggleSectionId(2);
    const elToggle = getElementById(toggleSectonId);
    if (!elToggle) {
      console.warn(`can't find the toggle section with id: {${toggleSectonId}`);
      return;
    }

    const tableId = toBenchamrkTimeSeriesComparisonTableId(
      `metric=${left.metric}`
    );
    const table = getElementById(tableId);
    // if the table is not exist,scroll to the toggle section
    if (!table) {
      scrollingToElement(elToggle);
      triggerUpdate();
      return;
    }
    const cell = await navigateToDataGrid(
      tableId,
      [`${left?.compiler}`],
      `${left?.suite}`,
      toggleSectonId
    );

    if (cell) {
      highlightUntilClick(cell);
    }
    triggerUpdate();
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
    } else {
      triggerUpdate();
    }
  };

  const onGoToUrl = () => {
    closeDialog();
    const url = toBenchmarkLegacyUrl(left, right);
    // open a new tab
    window.open(url, "_blank");
  };
  return (
    <List>
      {other?.parent === "timeSeriesChart" && (
        <NavListItem
          primary="Navigate to comparison table"
          secondary="Jump to the time series comparison table section on this page."
          onClick={onGoToTable}
        />
      )}
      {other?.parent === "comparisonTable" && (
        <NavListItem
          primary="Navigate to time series chart"
          secondary="Jump to the comparison table section on this page."
          onClick={onGoToChart}
        />
      )}
      <NavListItem
        primary="Navigate to detail view"
        secondary={`Open the detailed benchmark view for suite "${left?.suite}" and compiler "${left?.compiler}" in the compiler dashboard.`}
        onClick={onGoToUrl}
      />
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

  const compilerName =
    DISPLAY_NAMES_TO_COMPILER_NAMES[left.compiler] ?? left.compiler;
  return `/benchmark/${left.suite}/${compilerName}?${query}`;
}
