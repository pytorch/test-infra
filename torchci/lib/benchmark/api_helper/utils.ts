// Utility to extract params from either GET or POST
import { NextApiRequest } from "next";

/**
 * Key-value map describing metadata for a group.
 * Example: { dtype: "fp32", arch: "sm80", device: "cuda" }
 */
type GroupInfo = Record<string, string>;

/**
 * Represents a subgroup within a larger group.
 * Contains its own metadata and a list of data items.
 */
type Subgroup<T> = {
  /** Metadata fields for this subgroup (e.g., workflow_id). */
  group_info: GroupInfo;

  /** The actual list of data items belonging to this subgroup. */
  data: T[];
};

/**
 * Represents a grouped item at the top level.
 * Contains group-level metadata and a collection of subgroups.
 */
type GroupedItem<T> = {
  /** Metadata fields for this group (e.g., dtype, arch, compiler). */
  group_info: GroupInfo;

  /**
   * Rows keyed by a unique identifier string,
   * derived from a distinct combination of subgroup `group_info` fields.
   * Each entry corresponds to one subgroup that contains data points.
   */
  rows: Record<string, Subgroup<T>>;
};

/**
 * Generic parameters map passed into functions or queries.
 * Example: { startTime: "2025-08-24", device: "cuda", arch: "h100" }
 */
type Params = Record<string, any>;

// it accepts both ?parameters=<json string> and POST with JSON body
export function readApiGetParams(req: NextApiRequest): Params {
  // 1) If POST with parsed JSON body
  if (req.method === "POST" && req.body && typeof req.body === "object") {
    console.log("POST with parsed JSON body");
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
 * Group benchmark data by `keys`, and inside each group further subgroup by `subGroupKeys`.
 * @param data - benchmark data
 * @param keys - keys to group by
 * @param subGroupKeys - keys to subgroup by (optional): if not provided, a single subgroup will be created with "_ALL_" data
 */
export function groupByBenchmarkData<T>(
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
      subMap.set(subKey, { group_info: subInfo, data: [] });
    }
    subMap.get(subKey)!.data.push(row as T);
  }

  // build result array
  const result: GroupedItem<T>[] = [];
  for (const [mainKey, subMap] of groups.entries()) {
    const rowsObj = Object.fromEntries(subMap.entries());
    result.push({
      group_info: mainInfo.get(mainKey)!,
      rows: rowsObj,
    });
  }
  return result;
}

export function getNestedField(obj: any, path: string): any {
  return path.split(".").reduce((o, key) => (o && key in o ? o[key] : ""), obj);
}

export type BenchmarkTimeSeriesResponse = {
  data: any;
  time_range: { start: string; end: string };
  total_raw_rows?: number;
};

export type CommitRow = {
  head_branch: string;
  head_sha: string;
  id: string;
};

export function toWorkflowIdMap(data: any[]) {
  const commit_map = new Map<string, any>();
  data.forEach((row) => {
    const commit = row?.commit;
    const branch = row?.branch;
    const workflow_id = `${row.workflow_id}`;

    if (!commit || !branch || !workflow_id) {
      throw new Error(`failed to convert to workflowid map.
         commit, branch, workflow_id are required fields, but
          got ${commit}, ${branch}, ${workflow_id} from row ${row}`);
    }
    commit_map.set(workflow_id, {
      commit,
      branch,
      workflow_id,
    });
  });

  return commit_map;
}

export function toJobIdMap(data: any[]) {
  const commit_map = new Map<string, any>();
  data.forEach((row) => {
    const commit = row?.commit;
    const branch = row?.branch;
    const workflow_id = `${row.workflow_id}`;
    const job_id = `${row.job_id}`;

    if (!commit || !branch || !workflow_id) {
      throw new Error(`failed to convert to workflowid map.
         commit, branch, workflow_id are required fields, but
          got ${commit}, ${branch}, ${workflow_id} from row ${row}`);
    }
    commit_map.set(job_id, {
      job_id,
      workflow_id,
      commit,
      branch,
    });
  });

  return commit_map;
}

export function toTimeSeriesResponse(
  res: any,
  rawDataLength: number,
  start_ts: number,
  end_ts: number
) {
  const response: BenchmarkTimeSeriesResponse = {
    total_raw_rows: rawDataLength,
    time_range: {
      start: new Date(start_ts).toISOString(),
      end: new Date(end_ts).toISOString(),
    },
    data: res,
  };
  return response;
}

export function emptyTimeSeriesResponse() {
  return {
    total_rows: 0,
    time_series: [],
    table: [],
    time_range: {
      start: new Date().toISOString(),
      end: new Date().toISOString(),
    },
  };
}

export function makeGroupKey(groupInfo: GroupInfo): string {
  // Sort keys to make it stable
  const groupPart = Object.keys(groupInfo)
    .sort()
    .map((k) => `${k}=${groupInfo[k]}`)
    .join(",");

  return `${groupPart}`;
}

/**
 * convert the group data to time series data
 *
 * @param data
 * @returns
 */
export function to_time_series_data(
  data: any[],
  keys: string[],
  sub_keys: string[]
) {
  const tsd = groupByBenchmarkData(data, keys, sub_keys);

  let diffs: any[] = [];

  const result = tsd.map((group) => {
    const group_info = group.group_info;
    const sub_group_data = group.rows;
    // extract the first data point for each sub group
    // since we only have one datapoint for each unique workflow id with the same group info
    const ts_list = Object.values(sub_group_data)
      .filter((item) => item.data.length > 0)
      .map((item) => {
        if (item.data.length > 1) {
          const key = makeGroupKey(group_info);
          const sub_key = makeGroupKey(item.group_info);

          diffs.push({
            key: `${key}___${sub_key}`,
            data: item.data,
          });
        }
        return item.data[0];
      })
      .sort(
        (a, b) =>
          new Date(a.granularity_bucket).getTime() -
          new Date(b.granularity_bucket).getTime()
      );

    if (diffs.length > 0) {
      console.log(
        `we detected multiple datapoints for the same group keys ${diffs.length}`
      );
    }
    return {
      group_info,
      num_of_dp: ts_list.length,
      data: ts_list,
    };
  });
  return result;
}
