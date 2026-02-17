import { List } from "@mui/material";
import { Box } from "@mui/system";
import { highlightUntilClick } from "components/benchmark_v3/components/common/highlight";
import {
  getElementById,
  navigateToDataGrid,
  navigateToEchartInGroup,
  scrollingToElement,
} from "components/benchmark_v3/components/common/navigate";
import { TimeSeriesChartDialogContentProps } from "components/benchmark_v3/components/common/SelectionDialog";
import { NavListItem } from "components/benchmark_v3/components/common/styledComponents";
import { toToggleSectionId } from "components/benchmark_v3/components/common/ToggleSection";
import { toBenchmarkTimeseriesChartGroupId } from "components/benchmark_v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeSeriesChartGroup";
import { toBenchmarkTimeseriesChartSectionId } from "components/benchmark_v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeSeriesChartSection";
import { toBenchamrkTimeSeriesComparisonTableId } from "components/benchmark_v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTableSection";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { stateToQuery } from "lib/helpers/urlQuery";
import { NextRouter, useRouter } from "next/router";
/**
 * Customized dialog content for vllm precompute benchmark page.
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
export const VllmPrecomputeConfirmDialogContent: React.FC<
  TimeSeriesChartDialogContentProps
> = ({ left, right, other, closeDialog, triggerUpdate }) => {
  const router = useRouter();
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
    const toggleSectonId = toToggleSectionId(3);
    const elToggle = getElementById(toggleSectonId);
    if (!elToggle) {
      console.warn(`can't find the toggle section with id: {${toggleSectonId}`);
      return;
    }

    const tableId = toBenchamrkTimeSeriesComparisonTableId(`__ALL__`);

    const table = getElementById(tableId);
    // if the table is not exist,scroll to the toggle section
    if (!table) {
      scrollingToElement(elToggle);
      triggerUpdate();
      return;
    }
    const cell = await navigateToDataGrid(
      tableId,
      [`${left?.device}`],
      `${left?.metric}`,
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
      toBenchmarkTimeseriesChartSectionId(`__ALL__`),
      toBenchmarkTimeseriesChartGroupId(`metric=${left.metric}`),
      toToggleSectionId(2)
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
    triggerUpdate();
    // const url = toBenchmarkLegacyUrl(left, right);
    const url = toBenchmarkDashboardUrl(left, right, router);
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
        secondary={`Open the detail view for suite "${left?.suite}" and compiler "${left?.compiler}" in the compiler dashboard.`}
        onClick={onGoToUrl}
      />
    </List>
  );
};

function toBenchmarkDashboardUrl(left: any, right: any, router: NextRouter) {
  const pathname = "/benchmark/v3/dashboard/pytorch_x_vllm_benchmark";
  const lcommit: BenchmarkCommitMeta = {
    commit: left.commit,
    branch: left.branch,
    workflow_id: left.workflow_id,
    date: left.granularity_bucket,
  };
  const rcommit: BenchmarkCommitMeta = {
    commit: right.commit,
    branch: right.branch,
    workflow_id: right.workflow_id,
    date: right.granularity_bucket,
  };

  const filters = {
    model: left?.model,
    modelCategory: left?.modelCategory,
  };

  const reformattedPrams = stateToQuery({
    lcommit,
    rcommit,
    filters,
  });

  const nextDashboardMainQuery = {
    ...router.query, // keep existing params like lcommit, rcommit
    ...reformattedPrams,
    renderGroupId: "main",
  };
  const params = new URLSearchParams(
    Object.entries(nextDashboardMainQuery)
      .filter(([_, v]) => v != null && v !== "")
      .map(([k, v]) => [k, String(v)])
  );

  const url = `${pathname}?${params.toString()}`;
  return url;
}
