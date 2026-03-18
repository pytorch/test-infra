import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const queryName = req.query.queryName as string;
  const response = await queryClickhouseSaved(
    queryName,
    JSON.parse(req.query.parameters as string)
  );
  res.status(200).json(response);
}
