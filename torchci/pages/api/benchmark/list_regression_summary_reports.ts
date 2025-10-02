import { getCompilerCommits } from "lib/benchmark/api_helper/compilers/get_compiler_benchmark_data";
import { badRequest, parseTimestampToken, parseTimestampTokenSeconds } from "lib/benchmark/api_helper/compilers/helpers/common";
import {
  groupByBenchmarkData,
  readApiGetParams,
} from "lib/benchmark/api_helper/utils";
import { queryClickhouse } from "lib/clickhouse";
import { NextApiRequest, NextApiResponse } from "next";


const DEFAULT_QUERY_LIMIT = 25;
const MAX_QUERY_LIMIT = 200;

const REPORT_TABLE="fortesting.benchmark_regression_report"

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Only GET and POST allowed" });
  }

  const params = readApiGetParams(req);
  console.log("[API]list regression summmary report, received request:", params);

  // validate params
  if (
    !params ||
    !params.report_id
  ){
    return badRequest("Missing required params report_id");
  }

  // list regression summary report for a given type. ex compiler_regression
  const { report_id, limit, last_ts_token} = params;
  try {

    const query_limit = getQueryLimit(limit);

    const last_ts = parseTimestampTokenSeconds(last_ts_token);

    // validate last_ts_token only if it is provided
    if (last_ts_token && !last_ts) {
        return badRequest(`invalid input params last_ts_token "${last_ts_token}"`);
    }

    const { query, params } = buildQuery({
      table: REPORT_TABLE,
      report_id,
      limit: query_limit,
      ts_token: last_ts,
    });

    console.log("[API][DB]list regression summary reporr with params", params);
    const results = await queryClickhouse(query, params);
    return res.status(200).json(results);
  } catch (err: any) {
    console.error("API error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

function getQueryLimit(limit: any) {
    let query_limit = Number(limit ?? DEFAULT_QUERY_LIMIT);
    if (!Number.isFinite(query_limit) || query_limit <= 0) query_limit = DEFAULT_QUERY_LIMIT;
    query_limit = Math.min(Math.max(1, limit), MAX_QUERY_LIMIT);
    return query_limit;
  }

export function buildQuery({
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
      *,
      toISO8601(last_record_ts) AS last_record_ts_iso
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
