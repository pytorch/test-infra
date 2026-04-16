import LLMsBenchmarkPage from "components/benchmark/llms/LLMsBenchmarkPage";
import LLMsComparingBenchmarkPage from "components/benchmark/llms/LLMsComparingBenchmarkPage";
import { useRouter } from "next/router";

/**
 *
 * API routing endpoint for the LLMs pages. There are different modes of comparison, and based on the query params,
 * we will render the appropriate Benchmark page.
 */
export default function Page() {
  const router = useRouter();
  const reposParam = router.query.repos;
  const repos = Array.isArray(reposParam)
    ? reposParam
    : typeof reposParam === "string"
    ? reposParam.split(",").map((r) => r.trim())
    : [];
  return repos.length > 0 ? (
    <LLMsComparingBenchmarkPage />
  ) : (
    <LLMsBenchmarkPage />
  );
}
