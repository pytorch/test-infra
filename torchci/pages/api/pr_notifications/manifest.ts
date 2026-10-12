import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getOctokit } from "lib/github";
import {
  buildPrNotificationsManifest,
  getManifestKey,
} from "lib/prNotifications";
import { getS3Client } from "lib/s3";
import type { NextApiRequest, NextApiResponse } from "next";

const OWNER = "pytorch";
const REPO = "pytorch";
const BUCKET = "ossci-raw-job-status";

export const config = {
  maxDuration: 900,
};

/**
 * Writes the daily PR notifications manifest to S3. Called by the
 * pr-notifications-manifest workflow.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<
    | { error: string }
    | { key: string; prs: number; reviewers: number; failed_prs: number[] }
  >
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const key = process.env.DRCI_BOT_KEY;
  // An unset key must not turn into an open endpoint.
  if (!key || req.headers.authorization !== key) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const now = new Date();
  const octokit = await getOctokit(OWNER, REPO);
  const manifest = await buildPrNotificationsManifest(
    octokit,
    OWNER,
    REPO,
    now
  );
  const manifestKey = getManifestKey(now);
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: manifestKey,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    })
  );

  return res.status(200).json({
    key: manifestKey,
    prs: Object.keys(manifest.prs).length,
    reviewers: Object.keys(manifest.reviewers).length,
    failed_prs: manifest.failed_prs,
  });
}
