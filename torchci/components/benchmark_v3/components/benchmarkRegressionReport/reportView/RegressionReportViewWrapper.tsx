import { Alert } from "@mui/material";
import { Box } from "@mui/system";
import LoadingPage from "components/common/LoadingPage";
import { useGetBenchmarkRegressionReportData } from "lib/benchmark/api_helper/fe/hooks";
import BenchmarkRegressionReportMetadataSection from "./BenchmarkRegressionReportMetadataSection";
import { RegressionReportDetail } from "./RegressionReportDetail";

export function BenchmarkRegressionReportWrapper({
  id,
  enableTableSidePanel,
  singleChartSizeSx,
  groupChartSizeSx,
}: {
  id: string;
  enableTableSidePanel?: boolean;
  singleChartSizeSx?: any;
  groupChartSizeSx?: any;
}) {
  // initial load
  const { data, isLoading, error } = useGetBenchmarkRegressionReportData(
    id as string
  );

  if (isLoading) {
    return <LoadingPage />;
  }

  if (error) {
    return <Alert severity="error">{error.message}</Alert>;
  }

  return (
    <Box sx={{ p: 2 }}>
      <BenchmarkRegressionReportMetadataSection data={data} />
      <RegressionReportDetail
        report={data}
        enableTableSidePanel={enableTableSidePanel}
        singleChartSizeSx={singleChartSizeSx}
        groupChartSizeSx={groupChartSizeSx}
      />
    </Box>
  );
}
