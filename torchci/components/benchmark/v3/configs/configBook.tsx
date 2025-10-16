
const REPORT_ID_TO_BENCHMARK_ID_MAPPING: Record<string, string> = {
  compiler_regression: "compiler_inductor",
};

/**
 * A helper function to get benchmark id from report id
 * @param reportId
 * @returns
 */
export function getBenchmarkIdFromReportId(reportId: string): string {
  return REPORT_ID_TO_BENCHMARK_ID_MAPPING[reportId] ?? "";
}
