import { Alert } from "@mui/material";
import LoadingPage from "components/common/LoadingPage";
import { listBenchmarkRegressionReport } from "lib/benchmark/api_helper/fe/api";
import { useListBenchmarkRegressionReportsData } from "lib/benchmark/api_helper/fe/hooks";
import { useEffect, useState } from "react";
import RegressionReportList from "./RegressionReportListView";

export function BenchmarkRegressionReportListWrapper({
  report_id,
  limit,
}: {
  report_id: string;
  limit: number;
}) {
  const [reports, setReports] = useState<any[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // initial load
  const { data, isLoading, error } = useListBenchmarkRegressionReportsData(
    report_id as string,
    limit
  );

  // When the first page loads
  useEffect(() => {
    if (data) {
      setReports(data.reports ?? []);
      setNextCursor(data.next_cursor ?? null);
    }
  }, [data]);

  const fetchNext = async () => {
    if (!nextCursor) return;
    const res = await listBenchmarkRegressionReport<any>(
      report_id as string,
      limit,
      nextCursor // timestamp cursor
    );
    setReports((prev) => [...prev, ...(res.reports ?? [])]);
    setNextCursor(res.next_cursor ?? null);
  };

  if (isLoading) {
    return <LoadingPage />;
  }

  if (error) {
    return <Alert severity="error">{error.message}</Alert>;
  }

  return (
    <RegressionReportList
      reports={reports}
      hasNext={!!nextCursor}
      fetchNext={fetchNext}
    />
  );
}
