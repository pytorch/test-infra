import { Alert } from "@mui/material";

export function BenchmarkIdNotRegisterError({
  benchmarkId,
  content,
}: {
  benchmarkId: string;
  content: string;
}) {
  return (
    <Alert severity="error">
      {content}BenchmarkId `{benchmarkId}` is not registered in the repo, please
      register it as BenchmarkIdMappingItem in BENCHMARK_ID_MAPPING in the store
    </Alert>
  );
}
