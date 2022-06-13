import type { NextApiRequest, NextApiResponse } from "next";
import zlib from "zlib";

import fetchHud from "lib/fetchHud";
import { packHudParams } from "lib/types";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const params = packHudParams(req.query);
  const hudData = await fetchHud(params);
  const jsonData = JSON.stringify(hudData);
  res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=60")
    .setHeader("Content-Encoding", "gzip")
    .send(zlib.gzipSync(jsonData));
}
