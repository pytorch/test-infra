import { badRequest, readApiGetParams } from "lib/benchmark/api_helper/backend/common/utils";
import { queryClickhouse } from "lib/clickhouse";
import { NextApiRequest, NextApiResponse } from "next";
import { toMiniReport } from "./list_regression_summary_reports";

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
  if (!params || !params.id) {
    return badRequest("Missing required params id", res);
  }

  // list regression summary report for a unique id
  const { id } = params;
  try {
    const { query, params } = buildQuery({
      table: REPORT_TABLE,
      id,
    });
    console.log("[API][DB]get regression summary report with params", params);
    const result = await queryClickhouse(query, params);
    const resp = toMiniReport(result);
    if (resp.length > 1) {
      console.warn("found more than one report for id", id);
    }
    return res.status(200).json(resp[0]);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}

function buildQuery({ table, id }: { table: string; id: string }) {
  const query = `
    SELECT *
    FROM ${table}
    WHERE id = {id: String}
  `;
  // use named parameter binding
  const params = { id };

  return { query, params };
}
