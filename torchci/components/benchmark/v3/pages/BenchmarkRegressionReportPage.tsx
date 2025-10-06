import LoadingPage from "components/common/LoadingPage";
import { useBenchmarkRegressionReportData } from "lib/benchmark/api_helper/apis/hooks";
import { useRouter } from "next/router";

/**
 *
 * Page for displaying regression report
 *
 */
export function BenchmarkRegressionReportPage() {
  const router = useRouter();
  const { report_id } = router.query;

  const { data, loading, error } = useBenchmarkRegressionReportData(
    report_id as string,
    20
  );

  if (loading) {
    return <LoadingPage />;
  }

  if (error) {
    return <div>{error}</div>;
  }

  const reports = data?.reports ?? [];
  const next_cursor = data?.next_cursor;
  console.log(next_cursor);

  return (
    <div>
      <h1>Regression Report</h1>
      <div>
        {reports.map((report: any, index: number) => {
          return (
            <div key={index}>
              <h2>{report.title}</h2>
              <div>
                <pre>{JSON.stringify(report, null, 2)}</pre>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
