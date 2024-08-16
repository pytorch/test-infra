import { createClient } from "@clickhouse/client";
import { readFileSync } from "fs";

export function getClickhouseClient() {
  return createClient({
    host: process.env.CLICKHOUSE_HUD_USER_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME ?? "default",
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD ?? "",
  });
}

export async function queryClickhouse(
  query: string,
  params: Record<string, unknown>
) {
  /**
   * queryClickhouse
   * @param query: string, the sql query
   * @param params: Record<string, unknown>, the parameters to the query ex { sha: "abcd" }
   */
  const clickhouseClient = getClickhouseClient();
  const res = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: params,
  });

  return await res.json();
}

export function queryClickhouseSaved(
  queryName: string,
  inputParams: Record<string, unknown>
) {
  /**
   * queryClickhouseSaved
   * @param queryName: string, the name of the query, which is the name of the folder in clickhouse_queries
   * @param inputParams: Record<string, unknown>, the parameters to the query, an object where keys are the parameter names
   *
   * This function will filter the inputParams to only include the parameters that are in the query params json file
   */
  const query = readFileSync(`clickhouse_queries/${queryName}/sql.sql`, "utf8");
  const paramsText = require(`clickhouse_queries/${queryName}/params.json`);

  const queryParams = new Map(
    Object.entries(paramsText).map(([key, value]) => [key, inputParams[key]])
  );
  return queryClickhouse(query, Object.fromEntries(queryParams));
}
