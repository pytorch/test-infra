import {
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
} from "lib/benchmark/llms/common";
import ld from "lodash";
import {
  BenchmarkMetadataItem,
  BenchmarkMetadataType,
} from "../../common/type";
import { BenchmarkMetadataFetcher } from "../type";
import { ExecutableQueryBase, QueryBuilder } from "./queryBuilder";

/**
 * Query to get the list of metadata for a given benchmark name
 */
export class BenchmarkMetadataQuery
  extends ExecutableQueryBase
  implements BenchmarkMetadataFetcher
{
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

  postProcess(data: any) {
    return getDefaultBenchmarkMetadataGroup(data);
  }
}

export function getDefaultBenchmarkMetadataGroup(
  data: any[]
): BenchmarkMetadataItem[] {
  return [
    makeMetadataItem(
      data,
      "backend",
      BenchmarkMetadataType.BackendName,
      DEFAULT_BACKEND_NAME,
      "Backend"
    ),
    makeMetadataItem(
      data,
      "mode",
      BenchmarkMetadataType.ModeName,
      DEFAULT_MODE_NAME,
      "Mode"
    ),
    makeMetadataItem(
      data,
      "dtype",
      BenchmarkMetadataType.DtypeName,
      DEFAULT_DTYPE_NAME,
      "Dtype"
    ),
    makeMetadataItem(
      data,
      "device",
      BenchmarkMetadataType.DeviceName,
      DEFAULT_DEVICE_NAME,
      "Device Name",
      (r) => (r.device && r.arch ? `${r.device} (${r.arch})` : r.device)
    ),
  ].filter(Boolean) as BenchmarkMetadataItem[];
}

/**
 * find distinct values from data and create metadata item
 */
function makeMetadataItem(
  data: any[],
  field: string,
  type: BenchmarkMetadataType,
  defaultValue: string,
  labelName: string,
  formatter?: (r: any) => string | undefined
): BenchmarkMetadataItem | null {
  const values = ld.uniq(
    data.map((r) => (formatter ? formatter(r) : r[field])).filter(Boolean)
  ) as string[];

  if (values.length === 0) {
    return null;
  }
  return {
    type,
    options: [defaultValue, ...values],
    labelName,
  };
}

export class PytorchOperatorMicrobenchmarkMetadataFetcher
  extends ExecutableQueryBase
  implements BenchmarkMetadataFetcher
{
  private _data_query: BenchmarkMetadataQuery;

  constructor() {
    super();
    this._data_query = new BenchmarkMetadataQuery();
  }

  postProcess(data: any[]) {
    let li = getDefaultBenchmarkMetadataGroup(data);
    const item = makeMetadataItem(
      data,
      "operator",
      BenchmarkMetadataType.OperatornName,
      "All Operators",
      "Operator",
      (r) => r.model.split("_")[0] ?? "unknown"
    );
    if (item) {
      li.push(item);
    }
  }

  build() {
    return this._data_query.build();
  }

  toQueryParams(inputs: any) {
    return this._data_query.toQueryParams(inputs);
  }
}
