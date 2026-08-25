import { invokeLogUploader } from "lib/lambda";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Re-upload a job's log to S3.
 *
 * Replaces the synthetic `action: "backfill"` event that used to be POSTed at
 * github-status-test's API Gateway. That endpoint was public and unauthenticated;
 * gha-log-uploader has no public endpoint at all, so this route is the way in for
 * callers outside HUD (tools/scripts/backfill_events.py, manual ops).
 *
 * Code inside HUD should call invokeLogUploader directly rather than looping back
 * through here -- see backfillMissingLog in lib/jobUtils.
 */
interface BackfillRequest {
  repo?: string;
  job_id?: number | string;
  conclusion?: string | null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ error: string } | { queued: true }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const key = process.env.LOG_UPLOADER_BOT_KEY;
  // An unset key must not turn into an open endpoint.
  if (!key || req.headers.authorization !== key) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const {
    repo,
    job_id: rawJobId,
    conclusion,
  }: BackfillRequest = req.body ?? {};

  if (typeof repo !== "string" || !repo.includes("/")) {
    return res.status(400).json({ error: "'repo' must be 'owner/name'" });
  }

  const jobId = Number(rawJobId);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return res
      .status(400)
      .json({ error: "'job_id' must be a positive integer" });
  }

  try {
    await invokeLogUploader({ repo, job_id: jobId, conclusion });
  } catch (error) {
    console.error(
      `Failed to queue a log upload for ${repo} job ${jobId}`,
      error
    );
    return res.status(502).json({ error: "Failed to reach the log uploader" });
  }

  return res.status(200).json({ queued: true });
}
