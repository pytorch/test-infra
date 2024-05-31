import { DEFAULT_MODEL_NAME } from "components/benchmark/llms/common";
import { fetcher } from "lib/GeneralUtils";
import { RocksetParam } from "lib/rockset";
import { BranchAndCommit } from "lib/types";
import useSWR from "swr";

export function useBenchmark(
  queryParams: RocksetParam[],
  modelName: string,
  quantization: string,
  branchAndCommit: BranchAndCommit,
  getJobId: boolean = false
) {
  const queryCollection = "benchmarks";
  const queryName = "oss_ci_benchmark_llms";

  const queryParamsWithBranchAndCommit: RocksetParam[] = [
    {
      name: "names",
      type: "string",
      value: modelName === DEFAULT_MODEL_NAME ? "" : modelName,
    },
    {
      name: "quantization",
      type: "string",
      value: quantization,
    },
    {
      name: "getJobId",
      type: "bool",
      value: getJobId,
    },
    ...queryParams,
  ];

  if (branchAndCommit.branch) {
    queryParamsWithBranchAndCommit.push({
      name: "branches",
      type: "string",
      value: branchAndCommit.branch,
    });
  }

  if (branchAndCommit.commit) {
    queryParamsWithBranchAndCommit.push({
      name: "commits",
      type: "string",
      value: branchAndCommit.commit,
    });
  }

  const lUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithBranchAndCommit)
  )}`;

  return useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
}
