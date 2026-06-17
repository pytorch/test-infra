import { isAdvisorEnabled } from "lib/advisor/advisorConfig";
import {
  dispatchAdvisorWorkflow,
  isValidSha,
  readDispatchStates,
  recordDispatch,
  signalKeyForJob,
} from "lib/advisor/advisorDispatch";
import { hasWritePermissionsUsingOctokit } from "lib/GeneralUtils";
import { getOctokitWithUserToken } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Manual "AI Analyze" dispatch endpoint (the HUD button). Thin wrapper over the
 * shared advisor dispatch logic in lib/advisor/advisorDispatch: it adds the
 * interactive auth + write-permission gate, the per-repo enable check, and a
 * best-effort dedup record so the automatic Dr.CI loop won't re-dispatch a job a
 * human already triggered.
 *
 * Unlike the auto path, dedup here is best-effort (human-rate, no storm risk):
 * a ClickHouse read/write hiccup must not block a user's click.
 */
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

  // Per-repo enable gate (shared with the auto loop and the button visibility).
  if (!isAdvisorEnabled(owner, repo)) {
    return void res.status(404).json({
      error: `AI advisor is not enabled for ${owner}/${repo}`,
    });
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
  const record = {
    owner,
    repo,
    headSha,
    signalKey,
    retryCount: 0,
    prNumber,
    jobName,
  };

  // Best-effort dedup: skip if already dispatching/dispatched. A read failure
  // must not block the click, so fall through on error.
  try {
    const states = await readDispatchStates(owner, repo, headSha, [signalKey]);
    const prev = states.get(signalKey);
    if (prev && (prev.state === "dispatching" || prev.state === "dispatched")) {
      return void res.status(409).json({
        error: "Advisor was already dispatched for this job",
      });
    }
  } catch (e) {
    console.error("dispatch-advisor: dedup read failed, proceeding", e);
  }

  // Best-effort pre-dispatch marker (so the auto loop sees the manual dispatch).
  try {
    await recordDispatch({ ...record, state: "dispatching" });
  } catch (e) {
    console.error("dispatch-advisor: pre-dispatch write failed", e);
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
  } catch (error: any) {
    console.error("Failed to dispatch advisor:", error);
    try {
      await recordDispatch({ ...record, state: "failed" });
    } catch {
      // best-effort
    }
    return void res.status(500).json({
      error: "Failed to dispatch advisor workflow",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }

  try {
    await recordDispatch({ ...record, state: "dispatched" });
  } catch (e) {
    console.error("dispatch-advisor: post-dispatch write failed", e);
  }

  return void res.status(200).json({
    message: "Advisor workflow dispatched",
    prNumber,
    headSha,
    jobName,
  });
}
