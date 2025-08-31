import { deepClone } from "@mui/x-data-grid/internals";
import { EXCLUDED_METRICS } from "lib/benchmark/llms/common";
import { queryClickhouseSaved } from "lib/clickhouse";
import { BenchmarkGroupRequest } from "lib/datamodels/benchmark_group_request";
import { formatZodError } from "lib/datamodels/zodUtils";
import type { NextApiRequest, NextApiResponse } from "next";

const DEFAULT_TABLE_GROUP = [
  "device",
  "backend",
  "model",
  "dtype",
  "backend",
  "arch",
];
const DEFAULT_ROW_GROUP = ["workflow_id", "job_id", "metadata_info.timestamp"];
const BENCNMARK_TABLE_NAME = "oss_ci_benchmark_llms";

function getNestedField(obj: any, path: string): any {
  return path.split(".").reduce((o, key) => (o && key in o ? o[key] : ""), obj);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const request = BenchmarkGroupRequest.safeParse(req.query);

  if (!request.success) {
    return res.status(400).json({
      error: "Invalid query parameters",
      details: formatZodError(request.error),
    });
  }

  const qp = request.data;
  const groupTableByFields =
    qp.group_table_by_fields || deepClone(DEFAULT_TABLE_GROUP);
  const groupRowByFields = qp.groupRowByFields || deepClone(DEFAULT_ROW_GROUP);

  const params = {
    excludedMetrics: EXCLUDED_METRICS,
    benchmarks: [qp.benchmark_name],
    granularity: "hour",
    repo: qp.repo,
    startTime: qp.start_time,
    stopTime: qp.end_time,
    models: [],
    device: "",
    dtypes: [],
    backends: [],
    commits: [],
    branches: [],
    arch: "",
  };

  console.log("inputs", params);
  const response = await queryClickhouseSaved(BENCNMARK_TABLE_NAME, params);
  const tableGroups = new Map();

  response.forEach((row: any) => {
    // Build table-level key
    const tableKey = groupTableByFields
      .map((f: any) => `${getNestedField(row, f)}`)
      .join("|");

    const rowKey = groupRowByFields
      .map((f: any) => `${getNestedField(row, f)}`)
      .join("|");

    if (!tableGroups.has(tableKey)) {
      tableGroups.set(tableKey, new Map());
    }

    const tableMap = tableGroups.get(tableKey)!;
    if (!tableMap.has(rowKey)) {
      tableMap.set(rowKey, []);
      tableMap.set("group_data", new Map());
      groupRowByFields.forEach((f: any) => {
        tableMap.get("group_data").set(f, row[f]);
      });
    }
    tableMap.get(rowKey)!.push(row);
  });

  const result: {
    groupInfo: Record<string, string>;
    rows: Record<string, any[]>;
  }[] = [];

  for (const [tableKey, rowMap] of tableGroups.entries()) {
    const groupValues = tableKey.split("|");

    const groupInfo = Object.fromEntries(
      groupTableByFields.map((field: any, i: number) => [field, groupValues[i]])
    );

    const rows: Record<string, any[]> = Object.fromEntries(rowMap.entries());
    result.push({ groupInfo, rows });
  }

  const finalTables: {
    groupInfo: Record<string, string>;
    rows: Record<string, any>[];
  }[] = [];

  for (const group of result) {
    const pivotedRows: Record<string, any>[] = [];

    for (const rowList of Object.values(group.rows)) {
      if (!Array.isArray(rowList) || rowList.length === 0) continue; // ✅ Skip empty

      const rowObj: Record<string, any> = {};

      // Set row group fields from the first item
      groupRowByFields.forEach((field: string) => {
        rowObj[field] = getNestedField(rowList[0], field);
      });

      // Add each metric -> actual value
      for (const record of rowList) {
        // Only include valid metric and actual values
        if (record.metric && record.actual !== undefined) {
          rowObj[record.metric] = record.actual;
        }
      }
      pivotedRows.push(rowObj);
    }

    const info = deepClone(group.groupInfo);
    info["total_rows"] = pivotedRows.length;
    finalTables.push({
      groupInfo: info,
      rows: pivotedRows,
    });
  }
  res.status(200).json(finalTables);
}
