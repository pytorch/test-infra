// This file can't be imported by files on the client side (ex .tsx) due to
// lacking modules (ex fs) and required environment variables.  Run `yarn run
// build` to see the error and where it is imported from if vercel fails to
// deploy.
import { createClient } from "@clickhouse/client";
import { readFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
// Import itself to ensure that mocks can be applied, see
// https://stackoverflow.com/questions/51900413/jest-mock-function-doesnt-work-while-it-was-called-in-the-other-function
// https://stackoverflow.com/questions/45111198/how-to-mock-functions-in-the-same-module-using-jest
import * as thisModule from "./clickhouse";

export function getClickhouseClient() {
  return createClient({
    host: process.env.CLICKHOUSE_HUD_USER_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME ?? "default",
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD ?? "",
  });
}
//

export function getClickhouseClientWritable() {
  return createClient({
    host: process.env.CLICKHOUSE_HUD_USER_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_HUD_USER_WRITE_USERNAME ?? "default",
    password: process.env.CLICKHOUSE_HUD_USER_WRITE_PASSWORD ?? "",
  });
}

export async function queryClickhouse(
  query: string,
  params: Record<string, unknown>,
  query_id?: string,
  useQueryCache?: boolean
): Promise<any[]> {
  if (query_id === undefined) {
    query_id = "adhoc";
  }
  // This needs to be unique for each query
  query_id = `${query_id}-${uuidv4()}`;
  /**
   * queryClickhouse
   * @param query: string, the sql query
   * @param params: Record<string, unknown>, the parameters to the query ex { sha: "abcd" }
   * @param useQueryCache: boolean, if true, cache the query result on Ch side (1 minute TTL)
   */
  const clickhouseClient = getClickhouseClient();

  const res = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: params,
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 0,
      date_time_output_format: "iso",
      use_query_cache: useQueryCache ? 1 : 0,
    },
    query_id,
  });

  return (await res.json()) as any[];
}

export async function queryClickhouseSaved(
  queryName: string,
  inputParams: Record<string, unknown>,
  useQueryCache?: boolean
) {
  /**
   * queryClickhouseSaved
   * @param queryName: string, the name of the query, which is the name of the folder in clickhouse_queries
   * @param inputParams: Record<string, unknown>, the parameters to the query, an object where keys are the parameter names
   * @param useQueryCache: boolean, if true, cache the query result on Ch side (1 minute TTL)
   *
   * This function will filter the inputParams to only include the parameters
   * that are in the query params json file.
   *
   * During local development, if this fails due to "cannot find module ...
   * params.json", delete the .next folder and try again.
   */
  const query = readFileSync(
    // https://stackoverflow.com/questions/74924100/vercel-error-enoent-no-such-file-or-directory
    `${process.cwd()}/clickhouse_queries/${queryName}/query.sql`,
    "utf8"
  );
  let paramsText =
    require(`clickhouse_queries/${queryName}/params.json`).params;
  if (paramsText === undefined) {
    paramsText = {};
  }

  const queryParams = new Map(
    Object.entries(paramsText).map(([key, _]) => [key, inputParams[key]])
  );
  return await thisModule.queryClickhouse(
    query,
    Object.fromEntries(queryParams),
    queryName,
    useQueryCache
  );
}
