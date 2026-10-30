import { getOctokit, getPreReviewOctokit } from "lib/github";
import { refreshPrStatusComments } from "lib/prStatusSweep";
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { maxDuration: 900 };

// Reads use the dedicated pre-review app; only comment writes use PyTorchBot.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const key = process.env.DRCI_BOT_KEY;
  if (!key || req.headers.authorization !== key) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const reader = await getPreReviewOctokit("pytorch", "pytorch");
    if (!reader) {
      return res
        .status(503)
        .json({ error: "Pre-review app credentials are not configured" });
    }
    const writer = await getOctokit("pytorch", "pytorch");
    const result = await refreshPrStatusComments(
      reader,
      writer,
      "pytorch",
      "pytorch"
    );
    return res.status(result.failed.length ? 502 : 200).json({
      checked: result.checked,
      failed_prs: result.failed,
    });
  } catch (error) {
    console.error("PR status sweep failed", error);
    return res.status(503).json({ error: "PR status sweep failed" });
  }
}
