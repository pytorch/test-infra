
import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

const DEFAULT_TABLE_GROUP = [
  "device",
  "backend",
  "model",
  "dtype",
  "backend",
  "arch",
];
const BENCNMARK_TABLE_NAME = "compilers_benchmark_performance_v2";

type QueryParams = {
  startTime: string; // ISO timestamp
  stopTime: string;  // ISO timestamp
  [k: string]: any;  // other parameters
};


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {

  console.log("compiler_benmark_time_series.");
  const inputparams = JSON.parse(req.query.parameters as string)
  console.log("inputs", inputparams);

  const start = Date.now();
  const rows = await queryClickhouseSaved(BENCNMARK_TABLE_NAME, inputparams);
  const end = Date.now();
  console.log(`Process took ${end - start}ms`);

  console.log("merged rows:", rows.length);
  res.status(200).json({ data: rows });
}


