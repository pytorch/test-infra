import { queryClickhouseSaved } from "lib/clickhouse";
import {
  CRCR_HEALTH_STALE_AFTER_MINUTES,
  CRCR_HEALTH_WINDOW_MINUTES,
} from "lib/crcr/healthProbe";
import {
  L3_DEMOTION_WINDOW_DAYS,
  L3_PROMOTION_WINDOW_DAYS,
} from "lib/crcr/l3Thresholds";
import type {
  CrcrOverviewData,
  CrcrOverviewResponse,
  CrcrOverviewSection,
} from "lib/crcr/overview";
import { CRCR_TIME_RANGES } from "lib/crcr/timeRanges";
import type { NextApiRequest, NextApiResponse } from "next";

const NIGHTLY_HEALTH_REPO = "pytorch/crcr-test";
const NIGHTLY_HEALTH_LIMIT = 101;
const VALID_DAYS = new Set(CRCR_TIME_RANGES.map(({ days }) => days));

function getDays(req: NextApiRequest): number | null {
  const rawDays = req.query.days;
  if (typeof rawDays !== "string") return null;
  const days = Number(rawDays);
  return Number.isSafeInteger(days) && VALID_DAYS.has(days) ? days : null;
}

function emptyData(): CrcrOverviewData {
  return {
    prSummary: [],
    nightlySummary: [],
    prHealth: [],
    nightlyHealth: [],
    promotionReadiness: [],
    demotionReadiness: [],
    tenure: [],
  };
}

async function runSection<K extends CrcrOverviewSection>(
  data: CrcrOverviewData,
  errors: CrcrOverviewResponse["errors"],
  section: K,
  queryName: string,
  parameters: Record<string, number | string>
) {
  try {
    data[section] = (await queryClickhouseSaved(
      queryName,
      parameters,
      true
    )) as CrcrOverviewData[K];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`CRCR overview ${section} query error:`, message);
    errors[section] = message;
  }
}

/**
 * Fixed, serial query plan for the CRCR summary page. Its ClickHouse request
 * count is independent of the number of registered downstream backends.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrcrOverviewResponse | { error: string }>
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const days = getDays(req);
  if (days === null) {
    return res.status(400).json({ error: "Invalid CRCR time range" });
  }

  const data = emptyData();
  const errors: CrcrOverviewResponse["errors"] = {};

  // Deliberately serial: one page visit must not reserve seven ClickHouse slots
  // at once. Each saved query is grouped across repositories, so this remains
  // bounded as the CRCR allowlist grows.
  await runSection(data, errors, "prSummary", "crcr_summary", { days });
  await runSection(data, errors, "nightlySummary", "crcr_nightly_summary", {
    days,
  });
  await runSection(data, errors, "prHealth", "crcr_health_last_prs", {
    window_minutes: CRCR_HEALTH_WINDOW_MINUTES,
    stale_after_minutes: CRCR_HEALTH_STALE_AFTER_MINUTES,
  });
  await runSection(data, errors, "nightlyHealth", "crcr_nightly_dashboard", {
    repo: NIGHTLY_HEALTH_REPO,
    days: L3_PROMOTION_WINDOW_DAYS,
    limit: NIGHTLY_HEALTH_LIMIT,
    offset: 0,
  });
  await runSection(data, errors, "promotionReadiness", "crcr_l3_summary", {
    days: L3_PROMOTION_WINDOW_DAYS,
  });
  await runSection(data, errors, "demotionReadiness", "crcr_l3_summary", {
    days: L3_DEMOTION_WINDOW_DAYS,
  });
  await runSection(data, errors, "tenure", "crcr_repo_tenure_summary", {});

  res.setHeader(
    "Cache-Control",
    Object.keys(errors).length === 0
      ? "s-maxage=30, stale-while-revalidate=60"
      : "no-store"
  );
  return res.status(200).json({ data, errors });
}
