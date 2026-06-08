/**
 * POST /api/raw-query  { sql: string, params?: object }
 *
 * Runs an arbitrary read-only ClickHouse query. Not public: requires the
 * internal bot token (checkAuthWithApiToken), which the /api/authed shim
 * supplies after it has validated the caller's pytorch/pytorch write access.
 * So the only way to reach this with a user identity is via /api/authed/raw-query.
 *
 * Read-only is enforced three ways: the HUD read client (no write creds),
 * ClickHouse `readonly=2` (rejects writes/DDL), and a SELECT/WITH-only,
 * single-statement check. Results are capped.
 */
import { checkAuthWithApiToken } from "lib/auth/auth";
import { queryClickhouse } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

const SELECT_ONLY = /^\s*(select|with)\b/i;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await checkAuthWithApiToken(req, res);
  if (!auth.ok) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const sql = (body?.sql ?? "").trim().replace(/;\s*$/, "");
  const params = body?.params ?? {};

  if (!sql) {
    return res.status(400).json({ error: "Missing 'sql'" });
  }
  if (sql.includes(";")) {
    return res.status(400).json({ error: "Single statement only" });
  }
  if (!SELECT_ONLY.test(sql)) {
    return res
      .status(400)
      .json({ error: "Only SELECT / WITH queries allowed" });
  }

  try {
    const rows = await queryClickhouse(sql, params, "raw-query", false, {
      readonly: 2,
      max_execution_time: 60,
      max_result_rows: 10000,
      result_overflow_mode: "break",
    });
    return res.status(200).json(rows);
  } catch (error: any) {
    return res.status(400).json({ error: String(error?.message ?? error) });
  }
}
