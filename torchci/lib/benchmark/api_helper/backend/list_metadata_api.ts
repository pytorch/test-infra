import {
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
} from "lib/benchmark/llms/common";
import ld from "lodash";
import { BenchmarkMetadataItem, BenchmarkMetadataType } from "../type";
import { BenchmarkMetadataQuery } from "./queryBuilderUtils/defaultListMetadataQueryBuilder";
export async function listBenchmarkMetadata(queryParams: any, id: string) {
  // fetch metadata from db
  const db = await listBenchmarkMetadataFromDb(queryParams);
  const result = groupBenchmarkMetadata(db, id);
  return result;
}

async function listBenchmarkMetadataFromDb(queryParams: any) {
  const queryBuilder = new BenchmarkMetadataQuery();
  const results = queryBuilder.applyQuery(queryParams);
  return results;
}

/**
 * grouping benchmark metadata into group list
 */
function groupBenchmarkMetadata(data: any, id: string = "") {
  let groups = getDefaultBenchmarkMetadataGroup(data);
  const additionalGroups = getCustomizedBenchmarkMetadataGroup(data, id);
  return groups.concat(additionalGroups);
}

function getCustomizedBenchmarkMetadataGroup(data: any, id: string) {
  let items = [];
  switch (id) {
    case "pytorch_operator_microbenchmark":
      const item = makeMetadataItem(
        data,
        "operator",
        BenchmarkMetadataType.OperatornName,
        "All Operators",
        "Operator",
        (r) => r.model.split("_")[0] ?? "unknown"
      );
      if (item) {
        items.push(item);
      }
      return items;
    default:
      return [];
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
