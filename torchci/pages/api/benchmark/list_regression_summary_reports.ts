import {
  badRequest,
  parseTimestampTokenSeconds,
  readApiGetParams,
} from "lib/benchmark/api_helper/utils";
import { queryClickhouse } from "lib/clickhouse";
import { NextApiRequest, NextApiResponse } from "next";

const DEFAULT_QUERY_LIMIT = 25;
const MAX_QUERY_LIMIT = 200;

const REPORT_TABLE = "fortesting.benchmark_regression_report";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Only GET and POST allowed" });
  }

  const params = readApiGetParams(req);
  console.log(
    "[API]list regression summmary report, received request:",
    params
  );

  // validate params
  if (!params || !params.report_id) {
    return badRequest("Missing required params report_id", res);
  }

  // list regression summary report for a given type. ex compiler_regression
  const { report_id, limit, last_ts_token } = params;
  try {
    const query_limit = getQueryLimit(limit);
    const last_ts = parseTimestampTokenSeconds(last_ts_token);
    // validate last_ts_token only if it is provided
    if (last_ts_token && !last_ts) {
      return badRequest(
        `invalid input params last_ts_token "${last_ts_token}"`,
        res
      );
    }

    console.log(
      "[API][DB]list regression summary report with query_limit",
      query_limit
    );
    const results = await queryFromDb({
      report_id,
      limit: query_limit,
      ts_token: last_ts,
    });

    const resp = toApiFormat(results);

    return res.status(200).json(resp);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}

async function queryFromDb({
  report_id,
  limit,
  ts_token,
}: {
  report_id: string;
  limit: number;
  ts_token?: number | null; // epoch seconds or null
}) {
  const { query, params } = buildQuery({
    table: REPORT_TABLE,
    report_id,
    limit,
    ts_token,
  });

  console.log("[API][DB]list regression summary reporr with params", params);
  const results = await queryClickhouse(query, params);
  return results;
}

function buildQuery({
  table,
  report_id,
  limit,
  ts_token,
}: {
  table: string;
  report_id: string;
  limit: number;
  ts_token?: number | null; // epoch seconds or null
}) {
  const where: string[] = ["report_id = {report_id:String}"];
  if (ts_token != null) {
    where.push("last_record_ts < toDateTime({ts_token:UInt32})");
  }
  const whereSql = where.join(" AND ");

  const query = `
    SELECT
      *
    FROM ${table}
    WHERE ${whereSql}
    ORDER BY last_record_ts DESC
    LIMIT {limit:UInt32}
  `;

  const params: Record<string, string | number> = {
    report_id,
    limit,
    ...(ts_token != null ? { ts_token } : {}),
  };

  return { query, params };
}

function toApiFormat(dbResult: any[]) {
  const items = mapReportField(dbResult, "report");
  const next_cursor = items.length
    ? items[items.length - 1].last_record_ts
    : null;
  const miniReports = [];

  for (const item of items) {
    const { report, ...rest } = item;

    const otherFields = rest;

    if (!report) {
      return {
        ...otherFields,
      };
    }
    const policy = report.policy;
    const r = report?.report;
    const startInfo = r?.baseline_meta_data?.start;
    const endInfo = r?.baseline_meta_data?.end;
    const buckets = transformReportRows(r?.results ?? []);
    miniReports.push({
      ...otherFields,
      policy,
      start: startInfo,
      end: endInfo,
      details: buckets,
    });
  }

  return {
    reports: miniReports,
    next_cursor,
  };
}

function safeJsonParse<T = unknown>(s: unknown): T | null {
  if (s == null) return null;
  if (typeof s !== "string") return s as T; // already parsed or not a string
  try {
    return JSON.parse(s) as T;
  } catch {
    return null; // or throw if you prefer strictness
  }
}

/** Map ClickHouse rows so `report` (JSON string) becomes an object. */
function mapReportField<T = unknown>(
  rows: Array<Record<string, any>>,
  fieldName: string = "report"
): Array<Record<string, any>> {
  return rows.map((r) => ({
    ...r,
    [fieldName]: safeJsonParse<T>(r[fieldName]),
  }));
}

function getQueryLimit(limit: any) {
  let query_limit = Number(limit ?? DEFAULT_QUERY_LIMIT);
  if (!Number.isFinite(query_limit) || query_limit <= 0)
    query_limit = DEFAULT_QUERY_LIMIT;
  query_limit = Math.min(query_limit, MAX_QUERY_LIMIT);
  return query_limit;
}

export function transformReportRows(
  results: Array<Record<string, any>>
): Record<"regression" | "suspicious", any[]> {
  const resultBuckets: Record<"regression" | "suspicious", any[]> = {
    regression: [],
    suspicious: [],
  };

  for (const item of results) {
    if (item.label === "regression") {
      resultBuckets.regression.push(item);
    } else if (item.label === "suspicious") {
      resultBuckets.suspicious.push(item);
    }
  }
  return resultBuckets;
}
