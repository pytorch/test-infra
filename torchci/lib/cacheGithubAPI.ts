// Various utilities for caching GitHub API responses

import { createClient } from "@clickhouse/client";
import dayjs from "dayjs";
import * as thisModule from "./cacheGithubAPI";
import { queryClickhouse } from "./clickhouse";

export function enableCache() {
  // Used for testing
  return true;
}

function getClickhouseClient() {
  return createClient({
    host: process.env.CLICKHOUSE_HUD_USER_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_HUD_USER_WRITE_USERNAME ?? "default",
    password: process.env.CLICKHOUSE_HUD_USER_WRITE_PASSWORD ?? "",
  });
}

async function saveCache(key: string, data: any) {
  // Save the data to the cache
  //   console.log(data);
  if (!thisModule.enableCache()) {
    return;
  }
  const clickhouseClient = getClickhouseClient();
  await clickhouseClient.insert({
    table: "misc.github_api_cache",
    values: [
      [
        key,
        JSON.stringify(data),
        dayjs().utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
      ],
    ],
  });
}
async function readCache(key: string) {
  // Read the data from the cache
  if (!thisModule.enableCache()) {
    return null;
  }
  const query = `select data from misc.github_api_cache where key = {key: String}`;
  const params = { key };

  const dbResult = await queryClickhouse(query, params);
  if (dbResult.length == 1) {
    return JSON.parse(dbResult[0].data);
  }
  if (dbResult.length > 1) {
    await invalidateCache(key);
  }
  return null;
}

export async function invalidateCache(key: string) {
  // Invalidate the cache
  if (!thisModule.enableCache()) {
    return;
  }
  const query = `delete from misc.github_api_cache where key = {key: String}`;
  const params = { key };

  const clickhouseClient = getClickhouseClient();
  await clickhouseClient.command({ query, query_params: params });
}

export async function fetchAndCache<T>(key: string, func: () => T) {
  const dbResult = await readCache(key);
  if (dbResult) {
    return dbResult as T;
  }
  let result = await func();
  saveCache(key, result);
  return result;
}
