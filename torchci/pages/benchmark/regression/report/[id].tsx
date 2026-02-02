import { Alert } from "@mui/material";
import { Box } from "@mui/system";
import { BenchmarkReportFeatureSidePanel } from "components/benchmark_v3/components/benchmarkRegressionReport/BenchmarkReportFeatureSidePanel";
import BenchmarkRegressionReportMetadataSection from "components/benchmark_v3/components/benchmarkRegressionReport/reportView/BenchmarkRegressionReportMetadataSection";
import { RegressionReportDetail } from "components/benchmark_v3/components/benchmarkRegressionReport/reportView/RegressionReportDetail";
import { getRegressionConfig } from "components/benchmark_v3/configs/utils/regressionReportConfig";
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

  const config = getRegressionConfig(report_id as string);
  const include_non_regression =
    config?.include_non_regression !== null
      ? config.include_non_regression
      : true;

  return (
    <Box sx={{ p: 2 }}>
      <BenchmarkReportFeatureSidePanel
        type="list"
        id={report_id}
        buttonText={"report lists"}
      />
      <BenchmarkRegressionReportMetadataSection data={data} />
      <RegressionReportDetail
        report={data}
        include_non_regression={include_non_regression}
      />
    </Box>
  );
}
