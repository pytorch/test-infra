import { BenchmarkRegressionReportListWrapper } from "components/benchmark/v3/components/dataRender/components/benchmarkRegressionReport/listView/BenchmarkRegressionReportListWrapper";
import { useRouter } from "next/router";

export default function Page() {
  const router = useRouter();
  const { report_id } = router.query;
  const limitParam = router.query.limit;
  const limit = limitParam ? Number(limitParam) : 5; // default to 20

  return (
    <BenchmarkRegressionReportListWrapper
      report_id={report_id as string}
      limit={limit}
    />
  );
}
