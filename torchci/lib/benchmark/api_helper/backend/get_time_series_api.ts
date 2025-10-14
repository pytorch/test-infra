import { getCompilerBenchmarkData } from "../compilers/get_compiler_benchmark_data";
import { CompilerQueryType } from "../type";
import { BenchmarkDataQuery } from "./queryBuilderUtils/defaultGetBenchmarkDataQueryBuilder";

export async function getBenmarkTimeSeriesData(
  request_name: string,
  query_params: any,
  formats: string[] = ["time_series"]
) {
  switch (request_name) {
    case "compiler_precompute":
      return await getCompilerBenchmarkData(
        query_params,
        CompilerQueryType.PRECOMPUTE,
        formats
      );
    case "compiler":
      return await getCompilerBenchmarkData(
        query_params,
        CompilerQueryType.GENERAL,
        formats
      );
    case "pytorch_operator_microbenchmak":
      return await getBenchmarkData(query_params, formats, request_name);

    default:
      throw new Error(`Unsupported request_name: ${request_name}`);
  }
}

export async function getBenchmarkData(
  query_params: any,
  formats: string[],
  id: string
) {
  const queryBuilder = new BenchmarkDataQuery();

  const query = queryBuilder.applyQuery(query_params);
}
