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
    // 0-60s after first request: cache HIT
    // 60-300s after first request: cache HIT, but revalidation request will be sent.
    // see: https://vercel.com/docs/concepts/edge-network/caching#stale-while-revalidate
    .setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=240")
    .setHeader("Content-Encoding", "gzip")
    .send(zlib.gzipSync(jsonData));
}
