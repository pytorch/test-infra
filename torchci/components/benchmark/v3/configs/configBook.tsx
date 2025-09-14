import {
  CompilerPrecomputeBenchmarkUIConfig,
  COMPILTER_PRECOMPUTE_BENCHMARK_ID,
} from "../teamBasedComponents/compilers/config";
import { BenchmarkUIConfig } from "./type";

export const BenchmarkUIConfigBook: Record<string, BenchmarkUIConfig> = {
  [COMPILTER_PRECOMPUTE_BENCHMARK_ID]: CompilerPrecomputeBenchmarkUIConfig,
};
