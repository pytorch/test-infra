import {
  computeGeomean,
  computePassrate,
  computePeakMemoryUsage,
  convertToCompilerPerformanceData,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";
import { getNestedField } from "./group_data";

type GroupInfo = Record<string, string>;
type Subgroup<T> = { group_Info: GroupInfo; data: T[] };
type GroupedItem<T> = {
  group_Info: GroupInfo;
  rows: Record<string, Subgroup<T>>;
};
type Params = Record<string, any>;
const BENCNMARK_TABLE_NAME = "compilers_benchmark_performance";

/**
 * API Route: /api/benchmark/get_time_series
 *  Fetch benchmark time series data (e.g., compiler performance).
 *  currently only support compiler_precompute
 *
 * Supported Methods:
 *   - GET  : Pass parameters via query string
 *            Example:
 *              /api/benchmark/get_time_series?parameters={"name":"compiler_precompute","query_params":{...}}
 *   - POST : Pass parameters in JSON body
 *            Example:
 *              {
 *                "name": "compiler_precompute",
 *                "query_params": { ... }
 *              }
 **/
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Only GET and POST allowed" });
  }

  const params = readParams(req);
  console.log("[API]get_time_series, received request:", params);

  // validate params
  if (
    !params ||
    !params.query_params ||
    Object.keys(params.query_params).length == 0 ||
    Object.keys(params).length === 0
  ) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  // get time series data
  try {
    const { name, query_params } = params;
    const data = await getBenmarkTimeSeriesData(name, query_params);
    return res.status(200).json({ data });
  } catch (err: any) {
    console.error("API error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

async function getBenmarkTimeSeriesData(
  request_name: string,
  query_params: any
) {
  switch (request_name) {
    case "compiler_precompute":
      return await getCompilerBenchmarkData(query_params);
    default:
      throw new Error(`Unsupported request_name: ${request_name}`);
  }
}

// Utility to extract params from either GET or POST
// it accepts both ?parameters=<json string> and POST with JSON body
function readParams(req: NextApiRequest): Params {
  // 1) If POST with parsed JSON body
  if (req.method === "POST" && req.body && typeof req.body === "object") {
    return req.body as Params;
  }

  // 2) If POST with raw string body
  if (
    req.method === "POST" &&
    typeof req.body === "string" &&
    req.body.trim()
  ) {
    try {
      return JSON.parse(req.body) as Params;
    } catch {}
  }

  // 3) If GET with ?parameters=<json string>
  const raw = req.query.parameters as string | undefined;
  if (raw) {
    try {
      return JSON.parse(raw) as Params;
    } catch {}
  }

  // 4) Fallback: use query params directly
  const q: Params = {};
  Object.entries(req.query).forEach(([k, v]) => {
    if (k !== "parameters") q[k] = Array.isArray(v) ? v[0] : v;
  });
  return q;
}

/**
 * Group data by `keys`, and inside each group further subgroup by `subGroupKeys`.
 */
function groupBy<T>(
  data: T[],
  keys: string[],
  subGroupKeys: string[] = []
): GroupedItem<T>[] {
  const groups = new Map<string, Map<string, Subgroup<T>>>();
  const mainInfo = new Map<string, GroupInfo>();

  for (const row of data as any[]) {
    // build main group key
    const mainKeyParts = keys.map((k) => String(getNestedField(row, k)));
    const mainKey = mainKeyParts.join("|");
    if (!mainInfo.has(mainKey)) {
      const info: GroupInfo = {};
      keys.forEach((k, i) => (info[k] = mainKeyParts[i]));
      mainInfo.set(mainKey, info);
    }

    // build subgroup key
    const subKeyParts =
      subGroupKeys.length > 0
        ? subGroupKeys.map((k) => String(getNestedField(row, k)))
        : ["__ALL__"]; // default single subgroup if none provided
    const subKey = subKeyParts.join("|");
    const subInfo: GroupInfo = {};

    subGroupKeys.forEach((k, i) => (subInfo[k] = subKeyParts[i]));

    if (!groups.has(mainKey)) groups.set(mainKey, new Map());
    const subMap = groups.get(mainKey)!;

    if (!subMap.has(subKey)) {
      subMap.set(subKey, { group_Info: subInfo, data: [] });
    }
    subMap.get(subKey)!.data.push(row as T);
  }

  // build result array
  const result: GroupedItem<T>[] = [];
  for (const [mainKey, subMap] of groups.entries()) {
    const rowsObj = Object.fromEntries(subMap.entries());
    result.push({
      group_Info: mainInfo.get(mainKey)!,
      rows: rowsObj,
    });
  }
  return result;
}

async function getCompilerBenchmarkData(inputparams: any) {
  const start = Date.now();
  const rows = await queryClickhouseSaved(BENCNMARK_TABLE_NAME, inputparams);
  const end = Date.now();
  const result = toPrecomputeCompiler(rows, inputparams, "time_series");
  console.log("time to get data", end - start);
  return result;
}

function toPrecomputeCompiler(
  rawData: any[],
  inputparams: any,
  type: string = "time_series"
) {
  const data = convertToCompilerPerformanceData(rawData);
  const models = getPassingModels(data);

  const passrate = computePassrate(data, models);
  const geomean = computeGeomean(data, models);
  const peakMemory = computePeakMemoryUsage(data, models);

  const all_data = [passrate, geomean, peakMemory].flat();

  all_data.map((row) => {
    row["dtype"] = inputparams["dtype"];
    row["arch"] = inputparams["arch"];
    row["device"] = inputparams["device"];
    row["mode"] = inputparams["mode"];
  });

  let res: any[] = [];
  switch (type) {
    case "time_series":
      // grouping data by comipler, device, arch, dtype, suite, metric, mode
      // then sorted it with granularity_bucket in ascending order
      const tsd = groupBy(
        all_data,
        ["dtype", "arch", "device", "suite", "compiler", "metric", "mode"],
        ["workflow_id"]
      );
      res = tsd.map((group) => {
        const group_info = group.group_Info;
        const group_data = group.rows;

        // no need for the group_info for subgroup, directly get the data
        const ts_list = Object.values(group_data)
          .filter((item) => item.data.length > 0)
          .map((item) => item.data[0])
          .sort(
            (a, b) =>
              new Date(a.granularity_bucket).getTime() -
              new Date(b.granularity_bucket).getTime()
          );
        return {
          group_info,
          num_of_dp: ts_list.length,
          result: ts_list,
        };
      });
      return res;
    case "table":
      res = groupBy(
        all_data,
        [
          "dtype",
          "arch",
          "device",
          "mode",
          "workflow_id",
          "granularity_bucket",
        ],
        ["metric", "compiler"]
      );
  }

  return res;
}
