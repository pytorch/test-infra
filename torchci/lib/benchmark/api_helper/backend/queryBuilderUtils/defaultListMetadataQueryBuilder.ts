import { ExecutableQueryBase, QueryBuilder } from "./queryBuilder";

/**
 * Query to get the list of metadata for a given benchmark name
 */
export class BenchmarkMetadataQuery extends ExecutableQueryBase {
  private builder: QueryBuilder;
  private _DEFAULT_QUERY_PARAMS = {};
  constructor() {
    super();
    this.builder = new QueryBuilder({
      table: "benchmark.oss_ci_benchmark_metadata",
      distinct: true,
      select: [
        ["benchmark_name", "benchmark"],
        ["model_name", "model"],
        ["model_backend", "backend"],
        ["metric_name", "metric"],
        ["benchmark_dtype", "dtype"],
        ["benchmark_mode", "mode"],
        "device",
        "arch",
      ],
      prewhere: [
        "timestamp >= toUnixTimestamp({startTime: DateTime64(3)})",
        "timestamp < toUnixTimestamp({stopTime: DateTime64(3)})",
      ],
      where: [
        "repo = {repo: String}",
        "benchmark_name = {benchmarkName: String}",
        "notEmpty(metric_name)",
        "notEmpty(device)",
      ],
      orderBy: [
        "benchmark",
        "backend",
        "model",
        "metric",
        "dtype",
        "mode",
        "device",
      ],
    });
  }

  build() {
    return this.builder.build();
  }

  toQueryParams(inputs: any) {
    this.validateInputs(inputs);
    return {
      ...this._DEFAULT_QUERY_PARAMS,
      ...inputs,
    };
  }

  validateInputs(inputs: any) {
    if (!inputs.benchmarkName) {
      throw new Error("No benchmark names provided");
    }
    if (!inputs.repo) {
      throw new Error("No repo provided");
    }
  }
}
