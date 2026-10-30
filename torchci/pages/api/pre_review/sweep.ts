import { updateInProgressLabels } from "lib/bot/preReviewUtils";
import { getOctokit, getPreReviewOctokit } from "lib/github";
import {
  loadPreReviewRechecks,
  savePreReviewRechecks,
} from "lib/preReviewRechecks";
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { maxDuration: 900 };

// Independent of Dr.CI's handler and schedule. Only label writes use PyTorchBot;
// every GitHub read uses the pre-review app's separate rate limit.
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
    const rechecks = await loadPreReviewRechecks();
    const labeler = await getOctokit("pytorch", "pytorch");
    const result = await updateInProgressLabels(
      reader,
      labeler,
      "pytorch",
      "pytorch",
      rechecks
    );
    await savePreReviewRechecks(result.rechecks);
    return res.status(result.failed.length ? 502 : 200).json({
      checked: result.checked,
      deferred: result.deferred,
      failed_prs: result.failed,
    });
  } catch (error) {
    console.error("Pre-review sweep failed", error);
    return res.status(503).json({ error: "Pre-review sweep failed" });
  }
}
