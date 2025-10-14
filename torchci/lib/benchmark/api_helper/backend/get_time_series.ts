import { CompilerQueryType } from "./common/type";
import { getCompilerBenchmarkTimeSeriesData } from "./compilers/compiler_benchmark_data";
import { BenchmarkDataQuery } from "./queryBuilderUtils/defaultGetBenchmarkDataQueryBuilder";

export async function getBenchmarkTimeSeriesData(
  request_name: string,
  query_params: any,
  formats: string[] = ["time_series"],
) {
  switch (request_name) {
    case "compiler_precompute":
      return await getCompilerBenchmarkTimeSeriesData(
        query_params,
        CompilerQueryType.PRECOMPUTE,
        formats
      );
    case "compiler":
      return await getCompilerBenchmarkTimeSeriesData(
        query_params,
        CompilerQueryType.GENERAL,
        formats
      );
    case "pytorch_operator_microbenchmak":
      return await getGenernalBenchmarkTimeSeries(query_params, formats, request_name);
    default:
      throw new Error(`Unsupported request_name: ${request_name}`);
  }
}

async function getGenernalBenchmarkTimeSeries(query_params: any, formats: string[], id: string) {
  const queryBuilder = new BenchmarkDataQuery();
  const result = await queryBuilder.applyQuery(query_params);
  

}
