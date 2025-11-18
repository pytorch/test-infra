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
import RegressionReportTable from "./RegressionReportTable";
import { ReportTimeSereisChartSection } from "./RegressionReportTimeSeriesChart";
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
  chartSizeSx = { xs: 12, lg: 4 },
}: {
  report: any | null | undefined;
  showRaw?: boolean;
  enableTableSidePanel?: boolean;
  chartSizeSx?: any;
}) {
  const [selectedFilters, setSelectedFilters] = useState<
    Record<string, string | null>
  >({});
  const [view, setView] = useState<"chart" | "table">("table");

  const report_id = report.report_id;
  const details = report.details;
  const filterOptions = report.filters;
  const filtereddetails = useMemo(() => {
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
      <Box sx={{ mt: 3 }}>
        <ToggleButtonGroup
          value={view}
          exclusive
          onChange={(_, v) => v && setView(v)}
          size="small"
        >
          <ToggleButton value="chart">Chart View</ToggleButton>
          <ToggleButton value="table">Table View</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      {/* Conditionally render based on view */}
      {view === "chart" ? (
        <Box>
          <RegressionReportChartIndicatorsSection />
          <ToggleSection
            id={"regression_chart"}
            title={`Regressions (${filtereddetails.regression.length}/${details.regression.length})`}
          >
            <ReportTimeSeriesChartBucketList
              report_id={report_id}
              subtitle="regression"
              metricItemList={filtereddetails.regression}
              sizeSx={chartSizeSx}
            />
          </ToggleSection>
          <ToggleSection
            id={"suspicious_chart"}
            title={`Suspicious (${filtereddetails.suspicious.length}/${details.suspicious.length})`}
            defaultOpen={true}
          >
            <ReportTimeSeriesChartBucketList
              report_id={report_id}
              subtitle="suspicious"
              metricItemList={filtereddetails.suspicious}
              sizeSx={chartSizeSx}
            />
          </ToggleSection>
        </Box>
      ) : (
        <Box>
          <ToggleSection
            id={"regression_table"}
            title={`Regressions (${filtereddetails.regression.length}/${details.regression.length})`}
            defaultOpen={true}
          >
            <RegressionReportTable
              report_id={report_id}
              data={filtereddetails.regression}
              enableSidePanel={enableTableSidePanel}
            />
          </ToggleSection>
          <ToggleSection
            id={"suspicious_table"}
            title={`Suspicious (${filtereddetails.suspicious.length}/${details.suspicious.length})`}
            defaultOpen={true}
          >
            <RegressionReportTable
              report_id={report_id}
              data={filtereddetails.suspicious}
              enableSidePanel={enableTableSidePanel}
            />
          </ToggleSection>
        </Box>
      )}
    </Box>
  );
}

function ReportTimeSeriesChartBucketList({
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
              <ReportTimeSereisChartSection
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
