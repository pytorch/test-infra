import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const queryName = req.query.queryName as string;
  let parameters;
  try {
    parameters = JSON.parse(req.query.parameters as string);
  } catch (e) {
    return res
      .status(400)
      .json({ error: `Invalid parameters: ${errorMessage(e)}` });
  }
  try {
    const response = await queryClickhouseSaved(queryName, parameters);
    res.status(200).json(response);
  } catch (e) {
    // Without this, Next.js answers with a plain-text "Internal Server Error"
    // and fetcherHandleError fails parsing it, hiding the ClickHouse error.
    console.error(`ClickHouse query ${queryName} failed:`, e);
    res.status(500).json({ error: errorMessage(e) });
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
