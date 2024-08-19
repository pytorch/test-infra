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
): Promise<any[]> {
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

  return (await res.json()) as any[];
}

export async function queryClickhouseSaved(
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
  const query = readFileSync(
    // https://stackoverflow.com/questions/74924100/vercel-error-enoent-no-such-file-or-directory
    `${process.cwd()}/clickhouse_queries/${queryName}/query.sql`,
    "utf8"
  );
  const paramsText = require(`clickhouse_queries/${queryName}/params.json`);

  const queryParams = new Map(
    Object.entries(paramsText).map(([key, _]) => [key, inputParams[key]])
  );
  return await queryClickhouse(query, Object.fromEntries(queryParams));
}

export function enableClickhouse() {
  // Use this to quickly toggle between clickhouse and rockset
  return process.env.USE_CLICKHOUSE == "true";
}

export function coerceBoolNum(data: any[]) {
  // Coerces the types of an output from clickhouse to bool or number if
  // possible since clickhouse returns strings.  Does not yet handle nested
  // objects/tuples.
  for (const row of data) {
    for (const key in row) {
      if (row[key] === "true") {
        row[key] = true;
      } else if (row[key] === "false") {
        row[key] = false;
      } else if (!isNaN(row[key])) {
        row[key] = Number(row[key]);
      }
    }
  }
  return data;
}

export function numToNullableStr(val: number) {
  // Some code expects nullable strings for values that are usually numbers
  if (val === 0) {
    return null;
  }
  return val.toString();
}
