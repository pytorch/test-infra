import {
  BenchmarkPageType,
  BenchmarkUIConfig,
} from "lib/benchmark/store/benchmark_config_book";

/**
 * BenchmarkIdMappingItem is a mapping from benchmarkId to repoName and benchmarkName
 * benchmarkName is used to fetch the benchmark data from dv
 */
export interface BenchmarkIdMappingItem {
  id: string;
  repoName: string;
  benchmarkName: string; // highiest level benchmarkName that used to fetch the data from api
  benchmarkNameMapping?: Record<string, string>; // mapping from benchmarkName to benchmarkName based on page type, if this is defined, it overrides the main benchmarkName
}

export type BenchmarkConfigMap = Record<
  string,
  Partial<Record<BenchmarkPageType, BenchmarkUIConfig>>
>;
