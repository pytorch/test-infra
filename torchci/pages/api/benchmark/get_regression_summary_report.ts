import {
  badRequest,
  readApiGetParams,
} from "lib/benchmark/api_helper/backend/common/utils";
import { queryClickhouse } from "lib/clickhouse";
import { NextApiRequest, NextApiResponse } from "next";
import { mapReportField } from "./list_regression_summary_reports";

const EXCLUDED_FILTER_OPTIONS = ["branch"];
const REPORT_TABLE = "benchmark.benchmark_regression_report";
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

function toMiniReport(dbResult: any[]): any[] {
  if (!dbResult || !dbResult.length) return [];
  const items = mapReportField(dbResult, "report");
  const miniReports: any[] = [];
  for (const item of items) {
    const { report, ...rest } = item;

    const otherFields = rest;

    if (!report) {
      miniReports.push({
        ...otherFields,
      });
      continue;
    }
    const policy = report.policy;
    const r = report?.report;
    const startInfo = r?.baseline_meta_data?.start;
    const endInfo = r?.baseline_meta_data?.end;
    const { buckets, filterOptions } = transformReportRows(r?.results ?? []);
    miniReports.push({
      ...otherFields,
      filters: filterOptions,
      policy,
      start: startInfo,
      end: endInfo,
      details: buckets,
    });
  }
  return miniReports;
}

export function transformReportRows(results: Array<Record<string, any>>): {
  buckets: Record<"regression" | "suspicious" | "insufficient_data", any[]>;
  filterOptions: { type: string; options: string | any[]; labelName: string }[];
} {
  const filterOptions: Record<string, Set<string>> = {};
  const buckets: Record<
    "regression" | "suspicious" | "insufficient_data" | "no_regression",
    any[]
  > = {
    regression: [],
    suspicious: [],
    insufficient_data: [],
    no_regression: [],
  };

  for (const item of results) {
    const groupInfo = item.group_info ?? {};
    // --- collect unique values for each groupInfo key ---
    if (
      item.label === "regression" ||
      item.label === "suspicious" ||
      item.label === "insufficient_data"
    ) {
      for (const key of Object.keys(groupInfo)) {
        if (EXCLUDED_FILTER_OPTIONS.includes(key)) continue;
        const value = String(groupInfo[key]);

        if (!filterOptions[key]) {
          filterOptions[key] = new Set();
        }
        filterOptions[key].add(value);
      }
    }

    // --- bucket results ---
    if (item.label === "regression") {
      buckets.regression.push(item);
    } else if (item.label === "suspicious") {
      buckets.suspicious.push(item);
    } else if (item.label === "insufficient_data") {
      buckets.insufficient_data.push(item);
    }
  }
  // Convert Set → string[]
  const filterOptionsArr: {
    type: string;
    options: string | any[];
    labelName: string;
  }[] = [];
  const prefix = "extra_key.";
  for (const key of Object.keys(filterOptions)) {
    const list = Array.from(filterOptions[key]);
    if (list.length === 0) continue;
    if ((list.length === 1 && list[0] === "") || list[0] === null) continue;
    filterOptionsArr.push({
      type: key,
      labelName: key.startsWith(prefix) ? key.slice(prefix.length) : key,
      options: [
        {
          value: "",
          displayName: "All",
        },
        ...Array.from(filterOptions[key]),
      ],
    });
  }
  return { buckets, filterOptions: filterOptionsArr };
}
