// Rate limit users

import { createClient } from "@clickhouse/client";
import dayjs from "dayjs";
import { queryClickhouse } from "./clickhouse";

function getClickhouseClient() {
  return createClient({
    host: process.env.CLICKHOUSE_HUD_USER_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_HUD_USER_WRITE_USERNAME ?? "default",
    password: process.env.CLICKHOUSE_HUD_USER_WRITE_PASSWORD ?? "",
  });
}

async function checkRateLimit(user: string, key: string) {
  const res = await queryClickhouse(
    `
select count() as count from misc.rate_limit
where user = {user: String} and key = {key: String} and time_inserted > {timestamp: String}`,
    {
      user,
      key,
      timestamp: dayjs()
        .utc()
        .subtract(1, "hour")
        .format("YYYY-MM-DD HH:mm:ss"),
    }
  );
  if (res.length == 0) {
    return 0;
  }
  return res[0].count;
}

async function incrementRateLimit(user: string, key: string) {
  await getClickhouseClient().insert({
    table: "misc.rate_limit",
    values: [[user, key, dayjs().utc().format("YYYY-MM-DD HH:mm:ss")]],
  });
}
export async function drCIRateLimitExceeded(user: string) {
  const rateLimit = 10;
  return (await checkRateLimit(user, "DrCI")) >= rateLimit;
}

export async function incrementDrCIRateLimit(user: string) {
  return await incrementRateLimit(user, "DrCI");
}
