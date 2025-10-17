import { Alert } from "@mui/material";
import BenchmarkDashboardPage from "components/benchmark_v3/pages/BenchmarkDashboardPage";
import { useRouter } from "next/router";

export default function Page() {
  const router = useRouter();
  const { id } = router.query;
  const type = "dashboard";
  if (!id) {
    return <Alert severity="error">Cannot find the page </Alert>;
  }

  return <BenchmarkDashboardPage benchmarkId={id as string} type={type} />;
}
