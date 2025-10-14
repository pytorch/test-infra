import { Alert } from "@mui/material";
import { Box } from "@mui/system";
import { BenchmarkReportFeatureSidePanel } from "components/benchmark/v3/components/dataRender/components/benchmarkRegressionReport/BenchmarkReportFeatureSidePanel";
import BenchmarkRegressionReportMetadataSection from "components/benchmark/v3/components/dataRender/components/benchmarkRegressionReport/reportView/BenchmarkRegressionReportMetadataSection";
import { RegressionReportDetail } from "components/benchmark/v3/components/dataRender/components/benchmarkRegressionReport/reportView/RegressionReportDetail";
import LoadingPage from "components/common/LoadingPage";
import { useGetBenchmarkRegressionReportData } from "lib/benchmark/api_helper/fe/hooks";
import { useRouter } from "next/router";

export default function Page() {
  const router = useRouter();
  const { id } = router.query;

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

  const report_id = data?.report_id;

  return (
    <Box sx={{ p: 2 }}>
      <BenchmarkReportFeatureSidePanel
        type="list"
        id={report_id}
        buttonText={"report lists"}
      />
      <BenchmarkRegressionReportMetadataSection data={data} />
      <RegressionReportDetail report={data} />
    </Box>
  );
}
