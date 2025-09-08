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
  group_Info: GroupInfo;

  /**
   * Rows keyed by a unique identifier string,
   * derived from a distinct combination of subgroup `group_Info` fields.
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
      group_Info: mainInfo.get(mainKey)!,
      rows: rowsObj,
    });
  }
  return result;
}

export function getNestedField(obj: any, path: string): any {
  return path.split(".").reduce((o, key) => (o && key in o ? o[key] : ""), obj);
}

export type BenchmarkTimeSeriesResponse = {
  total_rows: number;
  time_series: any[];
  time_range: { start: string; end: string };
  total_raw_rows?: number;
};

export type CommitRow = {
  head_branch: string;
  head_sha: string;
  id: string;
};

export function toCommitRowMap(rows: CommitRow[]): Record<string, CommitRow> {
  const result: Record<string, CommitRow> = {};
  for (const row of rows) {
    result[row.id] = row;
  }
  return result;
}
