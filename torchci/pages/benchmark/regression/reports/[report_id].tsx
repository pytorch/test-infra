import { BenchmarkRegressionReportListWrapper } from "components/benchmark_v3/components/benchmarkRegressionReport/listView/BenchmarkRegressionReportListWrapper";
import { useRouter } from "next/router";

export default function Page() {
  const router = useRouter();
  const { report_id } = router.query;
  const limitParam = router.query.limit;
  const limit = limitParam ? Number(limitParam) : 20; // default to 20

  return (
    <BenchmarkRegressionReportListWrapper
      report_id={report_id as string}
      limit={limit}
    />
  );
}
