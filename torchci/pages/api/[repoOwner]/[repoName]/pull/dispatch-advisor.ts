import {
  dispatchAdvisorWorkflow,
  isValidSha,
  signalKeyForJob,
} from "lib/advisor/advisorDispatch";
import { queryClickhouse } from "lib/clickhouse";
import { hasWritePermissionsUsingOctokit } from "lib/GeneralUtils";
import { getOctokitWithUserToken } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return void res.status(405).json({ error: "Method not allowed" });
  }

  const authorization = req.headers.authorization;
  if (!authorization) {
    return void res.status(403).json({ error: "Authorization required" });
  }

  const owner = req.query["repoOwner"] as string;
  const repo = req.query["repoName"] as string;
  if (!owner || !repo) {
    return void res.status(400).json({ error: "Missing repo parameters" });
  }

  const { prNumber, headSha, mergeBaseSha, jobName, workflowName } = req.body;
  if (!prNumber || !headSha || !jobName) {
    return void res.status(400).json({
      error: "Missing required fields: prNumber, headSha, jobName",
    });
  }

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return void res.status(400).json({ error: "Invalid prNumber" });
  }

  if (!isValidSha(headSha)) {
    return void res.status(400).json({ error: "Invalid headSha format" });
  }
  if (mergeBaseSha && !isValidSha(mergeBaseSha)) {
    return void res.status(400).json({ error: "Invalid mergeBaseSha format" });
  }

  const octokit = await getOctokitWithUserToken(authorization);
  const user = await octokit.rest.users.getAuthenticated();
  if (!user?.data?.login) {
    return void res.status(403).json({ error: "Invalid credentials" });
  }

  const hasWritePerms = await hasWritePermissionsUsingOctokit(
    octokit,
    user.data.login,
    owner,
    repo
  );
  if (!hasWritePerms) {
    return void res.status(403).json({
      error: "Write permission required to dispatch advisor",
    });
  }

  const signalKey = signalKeyForJob(jobName);

  // Server-side dedup: skip if a verdict for this (sha, signal_key) was
  // already produced in the last 10 minutes, meaning a prior dispatch
  // already completed or is in-flight.
  try {
    const recentRows = await queryClickhouse(
      `SELECT 1
       FROM misc.autorevert_advisor_verdicts
       WHERE repo = {repo: String}
         AND suspect_commit = {sha: String}
         AND signal_key = {signalKey: String}
         AND timestamp > now() - INTERVAL 10 MINUTE
       LIMIT 1`,
      { repo: `${owner}/${repo}`, sha: headSha, signalKey }
    );
    if (recentRows.length > 0) {
      return void res.status(409).json({
        error: "Advisor was already dispatched for this job recently",
      });
    }
  } catch {
    // If the dedup check fails, proceed with dispatch anyway
  }

  try {
    await dispatchAdvisorWorkflow({
      owner,
      repo,
      prNumber,
      headSha,
      mergeBaseSha,
      jobName,
      workflowName,
    });
    return void res.status(200).json({
      message: "Advisor workflow dispatched",
      prNumber,
      headSha,
      jobName,
    });
  } catch (error: any) {
    console.error("Failed to dispatch advisor:", error);
    return void res.status(500).json({
      error: "Failed to dispatch advisor workflow",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}
