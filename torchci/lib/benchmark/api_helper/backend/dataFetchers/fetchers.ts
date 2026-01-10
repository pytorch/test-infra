import {
  BenchmarkDataQuery,
  PytorchAoMicroApiBenchmarkDataFetcher,
  PytorchHelionDataFetcher,
  PytorchOperatorMicroBenchmarkDataFetcher,
  VllmBenchmarkDataFetcher,
} from "./queryBuilderUtils/benchmarkDataQueryBuilder";
import {
  BenchmarkListCommitQueryBuilder,
  PytorchOperatorMicroListCommitsDataFetcher,
  VllmListCommitsDataFetcher,
} from "./queryBuilderUtils/listCommitQueryBuilder";
import {
  BenchmarkMetadataQuery,
  PytorchOperatorMicrobenchmarkMetadataFetcher,
  TorchAoMicrobApienchmarkMetadataFetcher,
  VllmBenchmarkMetadataFetcher,
} from "./queryBuilderUtils/listMetadataQueryBuilder";
import {
  BenchmarkDataFetcher,
  BenchmarkListCommitFetcher,
  BenchmarkMetadataFetcher,
} from "./type";

// Register benchmark data fetchers, this is mainly used in get_benchmark_data api and get_time_series api
const dataCtors: Record<string, new () => BenchmarkDataFetcher> = {
  pytorch_operator_microbenchmark: PytorchOperatorMicroBenchmarkDataFetcher,
  pytorch_helion: PytorchHelionDataFetcher,
  torchao_micro_api_benchmark: PytorchAoMicroApiBenchmarkDataFetcher,
  vllm_benchmark: VllmBenchmarkDataFetcher,
  pytorch_x_vllm_benchmark: VllmBenchmarkDataFetcher,
  default: BenchmarkDataQuery,
};

// Register benchmark metadata fetchers. this is mainly used in list_metadata api
const metaCtors: Record<string, new () => BenchmarkMetadataFetcher> = {
  pytorch_operator_microbenchmark: PytorchOperatorMicrobenchmarkMetadataFetcher,
  torchao_micro_api_benchmark: TorchAoMicrobApienchmarkMetadataFetcher,
  vllm_benchmark: VllmBenchmarkMetadataFetcher,
  default: BenchmarkMetadataQuery,
};

// Register benchmark list commit fetchers. this is mainly used in list_commits api
const listCommitsCtors: Record<string, new () => BenchmarkListCommitFetcher> = {
  pytorch_operator_microbenchmark: PytorchOperatorMicroListCommitsDataFetcher,
  vllm_benchmark: VllmListCommitsDataFetcher,
  default: BenchmarkListCommitQueryBuilder,
};

/**
 * Main function to get the query builder for a specific benchmark data
 * if id not found, return default query builder
 *
 */
export function getBenchmarkDataFetcher(id: string): BenchmarkDataFetcher {
  const Ctor = dataCtors[id] ?? dataCtors.default;
  return new Ctor();
}

/**
 * Main function to get the query builder for a specific benchmark data
 * if id not found, return default query builder
 */
export function getListBenchmarkMetadataFetcher(
  id: string
): BenchmarkMetadataFetcher {
  const Ctor = metaCtors[id] ?? metaCtors.default;
  return new Ctor();
}

export function getListBenchmarkCommitsFetcher(
  id: string
): BenchmarkListCommitFetcher {
  const predefinedCtor = listCommitsCtors[id];
  if (predefinedCtor) {
    console.log(`predefined list commits fetcher is picked for ${id}`);
  } else {
    console.log(`default list commits fetcher is picked for ${id}`);
  }
  const Ctor = predefinedCtor ?? listCommitsCtors.default;
  return new Ctor();
}
