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

  addWhere(where: string[]) {
    this.builder.addWhere(where);
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
      throw new Error("No benchmark name provided");
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
      { displayName: DEFAULT_BACKEND_NAME, value: "" },
      "Backend"
    ),
    makeMetadataItem(
      data,
      "mode",
      BenchmarkMetadataType.ModeName,
      { displayName: DEFAULT_MODE_NAME, value: "" },
      "Mode"
    ),
    makeMetadataItem(
      data,
      "dtype",
      BenchmarkMetadataType.DtypeName,
      { displayName: DEFAULT_DTYPE_NAME, value: "" },
      "Dtype"
    ),
    makeMetadataItem(
      data,
      "device",
      BenchmarkMetadataType.DeviceName,
      { displayName: DEFAULT_DEVICE_NAME, value: "" },
      "Device Name",
      "",
      (r: any) => {
        if (r.device && r.arch) {
          return {
            value: `${r.device}||${r.arch}`,
            displayName: `${r.device} (${r.arch})`,
          };
        }
        if (r.device) {
          return {
            value: r.device,
            displayName: r.device,
          };
        }

        return { value: "", displayName: "" };
      }
    ),
    makeMetadataItem(
      data,
      "model",
      BenchmarkMetadataType.ModelName,
      { displayName: "All Models", value: "" },
      "Model Name"
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
  defaultValue: { value: string; displayName: string },
  labelName: string,
  initialValue: string = "",
  formatter?: (r: any) => { value: string; displayName: string }
): BenchmarkMetadataItem | null {
  const values = ld.uniqBy(
    data
      .map((r) => {
        // formatter must return { value, displayName }
        const formatted = formatter
          ? formatter(r)
          : {
              value: r[field],
              displayName: r[field],
            };
        if (!formatted?.displayName) return null;
        return formatted;
      })
      .filter(Boolean),
    "value"
  ) as { value: string; displayName: string }[];

  if (values.length === 0) {
    return null;
  }
  return {
    type,
    options: [defaultValue, ...values],
    labelName,
    initialValue,
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
      { displayName: "All Operators", value: "" },
      "Operator",
      "",
      (r) => {
        const splitted = r.model.split("_");
        let value = undefined;
        if (splitted.length > 1) {
          value = splitted[0];
        }
        return {
          value: value,
          displayName: value,
        };
      }
    );
    if (item) {
      li.push(item);
    }
    return li;
  }

  build() {
    // console.log(this._data_query.build());
    return this._data_query.build();
  }

  toQueryParams(inputs: any) {
    const params = { ...inputs, operatorName: inputs.operatorName ?? "" };
    return this._data_query.toQueryParams(params);
  }
}

export class TorchAoMicrobApienchmarkMetadataFetcher
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
    li = li.filter((item) => item.type !== BenchmarkMetadataType.DtypeName);
    const customizedDtype = makeMetadataItem(
      data,
      "dtype",
      BenchmarkMetadataType.DtypeName,
      { displayName: "All Quant type", value: "" },
      "Quant Type"
    );
    if (customizedDtype) {
      li.push(customizedDtype);
    }
    return li;
  }
  build() {
    return this._data_query.build();
  }

  toQueryParams(inputs: any) {
    return this._data_query.toQueryParams(inputs);
  }
}
