import { Alert } from "@mui/material";
import { BenchmarkPageType } from "components/benchmark_v3/configs/config_book_types";
import BenchmarkSinglePage from "components/benchmark_v3/pages/BenchmarkSinglePage";
import { useRouter } from "next/router";

export default function Page() {
  const router = useRouter();
  const { id } = router.query;
  const type: BenchmarkPageType = BenchmarkPageType.SinglePage;
  if (!id) {
    return <Alert severity="error">Cannot find the page </Alert>;
  }
  return <BenchmarkSinglePage benchmarkId={id as string} type={type} />;
}
