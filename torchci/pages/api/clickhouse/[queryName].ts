import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const queryName = req.query.queryName as string;

  // detect if parameters are in the legacy Rockset lambda format
  // (if they all contain "name", "type", and "value" keys)
  // and convert them to the new format if so
  let parameters = JSON.parse(req.query.parameters as string);

  if (
    Array.isArray(parameters) &&
    parameters.every(
      (param: any) => "name" in param && "type" in param && "value" in param
    )
  ) {
    const newParams: Record<string, any> = {};
    for (const param of parameters) {
      newParams[param.name] = param.value;
    }
    parameters = newParams;
  }

  const response = await queryClickhouseSaved(queryName, parameters);
  res.status(200).json(response);
}
