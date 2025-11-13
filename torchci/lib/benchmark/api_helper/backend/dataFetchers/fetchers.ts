import {
  BenchmarkDataQuery,
  GptfastBenchmarkDataFetcher,
  PytorchAoMicroApiBenchmarkDataFetcher,
  PytorchHelionDataFetcher,
  PytorchOperatorMicroBenchmarkDataFetcher,
  VllmBenchmarkDataFetcher,
} from "./queryBuilderUtils/benchmarkDataQueryBuilder";
import {
  BenchmarkMetadataQuery,
  PytorchOperatorMicrobenchmarkMetadataFetcher,
} from "./queryBuilderUtils/listMetadataQueryBuilder";
import { BenchmarkDataFetcher, BenchmarkMetadataFetcher } from "./type";

// Register benchmark data fetchers, this is mainly used in get_benchmark_data api and get_time_series api
const dataCtors: Record<string, new () => BenchmarkDataFetcher> = {
  pytorch_operator_microbenchmark: PytorchOperatorMicroBenchmarkDataFetcher,
  pytorch_helion: PytorchHelionDataFetcher,
  torchao_micro_api_benchmark: PytorchAoMicroApiBenchmarkDataFetcher,
  vllm_benchmark: VllmBenchmarkDataFetcher,
  pytorch_gptfast_benchmark: GptfastBenchmarkDataFetcher,
  default: BenchmarkDataQuery,
};

// Register benchmark metadata fetchers. this is mainly used in list_metadata api
const metaCtors: Record<string, new () => BenchmarkMetadataFetcher> = {
  pytorch_operator_microbenchmark: PytorchOperatorMicrobenchmarkMetadataFetcher,
  default: BenchmarkMetadataQuery,
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
