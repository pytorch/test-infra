import { useRouter } from "next/router";
import { Alert, Grid, Link } from "@mui/material";
import BenchmarkDashboardPage from "components/benchmark/v3/pages/BenchmarkDashboardPage";

export default function Page() {
  const router = useRouter();
  const { id } = router.query;
  if(!id){
    return <Alert severity="error">Cannot find the page </Alert>
  }

  return  <BenchmarkDashboardPage benchmarkId={id as string} />

}
