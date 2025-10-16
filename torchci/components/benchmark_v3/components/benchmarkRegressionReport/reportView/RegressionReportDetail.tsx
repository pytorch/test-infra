import { Box, Grid } from "@mui/system";

import {
  Divider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useState } from "react";
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
  const [view, setView] = useState<"chart" | "table">("table");
  if (!report) {
    return <Box>Report not found</Box>;
  }

  if (!report?.details) {
    return <Box>Report details not found</Box>;
  }

  const report_id = report.report_id;
  const details = report.details;
  return (
    <Box>
      {/* Toggle Control */}
      <Box sx={styles.toggleSection}>
        <Typography variant="h6">Regression Report</Typography>
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
      <Divider sx={{ mb: 2 }} />
      {/* Conditionally render based on view */}
      {view === "chart" ? (
        <Box>
          <RegressionReportChartIndicatorsSection />
          <ReportTimeSeriesChartBucketList
            report_id={report_id}
            title={`Regressions (${details.regression.length})`}
            subtitle="regression"
            metricItemList={details.regression}
            sizeSx={chartSizeSx}
          />
          <ReportTimeSeriesChartBucketList
            report_id={report_id}
            title={`Suspicious (${details.suspicious.length})`}
            subtitle="suspicious"
            metricItemList={details.suspicious}
            sizeSx={chartSizeSx}
          />
        </Box>
      ) : (
        <Box>
          <RegressionReportTable
            report_id={report_id}
            data={details.regression}
            title={`Regressions (${details.regression.length})`}
            enableSidePanel={enableTableSidePanel}
          />
          <RegressionReportTable
            report_id={report_id}
            data={details.suspicious}
            title={`Suspicious (${details.suspicious.length})`}
            enableSidePanel={enableTableSidePanel}
          />
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
  title: string;
  subtitle?: string;
  metricItemList: any[];
  report_id: string;
  sizeSx?: any;
}) {
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
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
