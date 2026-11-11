import { updateInProgressLabels } from "lib/bot/triageSweep";
import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { maxDuration: 900 };

// Recover missed triage webhooks independently of Dr.CI. PyTorchBot reads live
// eligibility and writes the review-triggering label without a separate
// status-reader app or persistence dependency. Each batch is bounded.
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
    const bot = await getOctokit("pytorch", "pytorch");
    const result = await updateInProgressLabels(bot, bot, "pytorch", "pytorch");
    return res.status(result.failed.length ? 502 : 200).json({
      checked: result.checked,
      failed_prs: result.failed,
    });
  } catch (error) {
    console.error("Triage recovery sweep failed", error);
    return res.status(503).json({ error: "Triage recovery sweep failed" });
  }
}
