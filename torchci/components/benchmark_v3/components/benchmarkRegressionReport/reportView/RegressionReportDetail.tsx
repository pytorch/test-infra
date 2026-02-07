import { Box, Grid } from "@mui/system";

import {
  Divider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import BenchmarkDropdownGroup from "../../benchmarkSideBar/components/filters/BenchmarkFilterDropdownGroup";
import { ToggleSection } from "../../common/ToggleSection";
import { RegressionReportChartIndicatorsSection } from "../common";
import {
  ReportTimeSeriesChartSection,
  ReportTimeSeriesGroupChartSection,
} from "./RegressionReportTimeSeriesChart";
import { ReportDataSection } from "./ReportDataSection";

const styles = {
  toggleSection: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    mb: 2,
  },
};

export function RegressionReportDetail({
  report,
  enableTableSidePanel = true,
  include_non_regression = true,
  singleChartSizeSx = { xs: 12, lg: 4 },
  groupChartSizeSx = { xs: 12, lg: 6 },
}: {
  report: any | null | undefined;
  showRaw?: boolean;
  enableTableSidePanel?: boolean;
  singleChartSizeSx?: any;
  include_non_regression?: boolean;
  groupChartSizeSx?: any;
}) {
  const [selectedFilters, setSelectedFilters] = useState<
    Record<string, string | null>
  >({});
  const [view, setView] = useState<
    "group-chart-view" | "single-chart-view" | "table"
  >("group-chart-view");

  const report_id = report.report_id;
  const details = useMemo(() => {
    const d = report.details;
    if (!include_non_regression) {
      const { insufficient_data, no_regression, ...rest } = d;
      return rest;
    }
    return d;
  }, [report.details, include_non_regression]);

  const filterOptions = report.filters;
  const includeKeys = useMemo(() => {
    return (filterOptions || []).map((item: { type: string }) => item?.type);
  }, [filterOptions]);

  const filtered_details = useMemo(() => {
    const shouldFilter = Object.entries(selectedFilters).filter(
      ([_, v]) => v !== null && v !== ""
    );
    if (shouldFilter.length === 0) return details;

    const applyFilter = (row: any) => {
      return shouldFilter.every(([key, value]) => {
        if (!row.group_info) return false;
        return row.group_info[key] === value;
      });
    };
    return {
      regression: details.regression.filter(applyFilter),
      suspicious: details.suspicious.filter(applyFilter),
      insufficient_data: details.insufficient_data.filter(applyFilter),
    };
  }, [details, selectedFilters]);

  if (!report) {
    return <Box>Report not found</Box>;
  }

  if (!report?.details) {
    return <Box>Report details not found</Box>;
  }

  return (
    <Box>
      {/* Toggle Control */}
      <Box>
        <Typography variant="h6">Regression Report</Typography>
      </Box>
      <Box sx={{ mt: 3 }}>
        <Typography variant="h6">filter regression </Typography>
        <BenchmarkDropdownGroup
          horizontal={true}
          optionListMap={filterOptions}
          onChange={(_key: string, _value: any) => {
            setSelectedFilters((prev) => ({
              ...prev,
              [_key]: _value,
            }));
          }}
          props={selectedFilters}
          sx={{
            minWidth: 100,
          }}
          stackSx={{
            flexWrap: "wrap",
            alignItems: "center",
          }}
        />
      </Box>
      <Divider sx={{ mb: 2, mt: 1 }} />
      <Box>
        <Typography variant="h6">Chart Reports</Typography>
      </Box>
      <Box sx={{ mt: 3 }}>
        <ToggleButtonGroup
          value={view}
          exclusive
          onChange={(_, v) => v && setView(v)}
          size="small"
        >
          <ToggleButton value="group-chart-view">Group Chart View</ToggleButton>
          <ToggleButton value="single-chart-view">
            Single Chart View
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
      {/* Conditionally render based on view */}

      {view === "single-chart-view" && (
        <Box>
          <RegressionReportChartIndicatorsSection />
          <ToggleSection
            id={"regression_chart"}
            title={`Regressions (${filtered_details.regression.length}/${details.regression.length})`}
          >
            <ReportTimeSeriesSingleChartBucketList
              report_id={report_id}
              subtitle="regression"
              metricItemList={filtered_details.regression}
              sizeSx={singleChartSizeSx}
            />
          </ToggleSection>
          <ToggleSection
            id={"suspicious_chart"}
            title={`Suspicious (${filtered_details.suspicious.length}/${details.suspicious.length})`}
            defaultOpen={true}
          >
            <ReportTimeSeriesSingleChartBucketList
              report_id={report_id}
              subtitle="suspicious"
              metricItemList={filtered_details.suspicious}
              sizeSx={singleChartSizeSx}
            />
          </ToggleSection>
        </Box>
      )}
      {view === "group-chart-view" && (
        <Box>
          <RegressionReportChartIndicatorsSection />
          <ToggleSection
            id={"regression_chart"}
            title={`Regressions (${filtered_details.regression.length}/${details.regression.length})`}
          >
            <ReportTimeSeriesGroupChartBucketList
              report_id={report_id}
              subtitle="regression"
              metricItemList={filtered_details.regression}
              sizeSx={groupChartSizeSx}
            />
          </ToggleSection>
          <ToggleSection
            id={"suspicious_chart"}
            title={`Suspicious (${filtered_details.suspicious.length}/${details.suspicious.length})`}
            defaultOpen={true}
          >
            <ReportTimeSeriesGroupChartBucketList
              report_id={report_id}
              subtitle="suspicious"
              metricItemList={filtered_details.suspicious}
              sizeSx={groupChartSizeSx}
            />
          </ToggleSection>
          {include_non_regression ? (
            <ToggleSection
              id={"insufficient_data_table"}
              title={`Insufficient data (${filtered_details.insufficient_data.length}/${details.insufficient_data.length})`}
              defaultOpen={false}
            >
              <ReportDataSection
                report_id={report_id}
                metricItemList={filtered_details?.insufficient_data}
                includeKeys={includeKeys}
                orderedKeys={includeKeys}
                description='Metrics with insufficient data to determine regression status. At least
        2 data points are required for analysis for baseline points and latest
        points. The "Latest" column shows the most recent timestamp.'
              />
            </ToggleSection>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

/**
 * regression report time series chart group by arch, device and metric
 * @param param0
 * @returns
 */
function ReportTimeSeriesGroupChartBucketList({
  title,
  metricItemList,
  subtitle = "",
  report_id,
  sizeSx = { xs: 12, lg: 4 },
}: {
  title?: string;
  subtitle?: string;
  metricItemList: any[];
  report_id: string;
  sizeSx?: any;
}) {
  const groupedByArchDeviceMetric = metricItemList.reduce((acc, item) => {
    const { arch, device, metric } = item.group_info || {};
    // Create a composite key
    const key = `Hardware:${arch}(${device}) Metric:${metric}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
  const groups = Object.entries(groupedByArchDeviceMetric);
  return (
    <Box>
      {title && (
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          {title}
        </Typography>
      )}
      {groups.length > 0 && (
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          We found {groups.length} groups of {subtitle} based on hardware,
          metric, and filters. To see more details, please select line in the
          time series chart.
        </Typography>
      )}
      <Grid container spacing={1}>
        {groups.map(([key, items]) => {
          return (
            <Grid size={sizeSx} key={key}>
              <ReportTimeSeriesGroupChartSection
                data={items as any[]}
                subtitle={`${key}`}
                report_id={report_id}
                enableSelectLine={true}
              />
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
}

function ReportTimeSeriesSingleChartBucketList({
  title,
  metricItemList,
  subtitle = "",
  report_id,
  sizeSx = { xs: 12, lg: 4 },
}: {
  title?: string;
  subtitle?: string;
  metricItemList: any[];
  report_id: string;
  sizeSx?: any;
}) {
  return (
    <Box>
      {title && (
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          {title}
        </Typography>
      )}
      <Grid container spacing={1}>
        {metricItemList.map((item, i) => {
          return (
            <Grid size={sizeSx} key={i}>
              <ReportTimeSeriesChartSection
                data={item}
                subtitle={`${subtitle}[${i}]`}
                hideBaseline={true}
                report_id={report_id}
              />
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
}
