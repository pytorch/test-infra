import { hasWritePermissionsUsingOctokit } from "lib/GeneralUtils";
import { queryClickhouse } from "lib/clickhouse";
import { getOctokit, getOctokitWithUserToken } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

const SHA_REGEX = /^[0-9a-f]{7,40}$/i;

function isValidSha(sha: string): boolean {
  return SHA_REGEX.test(sha);
}

/**
 * Derive a LIKE pattern from a HUD job name that matches both
 * PR variants (-partial) and trunk variants (-all).
 * E.g. "Lint / lintrunner-pyrefly-partial / lint"
 *   -> "Lint / lintrunner-pyrefly-% / lint"
 * Also strips shard parentheticals: "pull / job (default, 1, 5, ...)"
 *   -> "pull / job%"
 */
function jobNameToBasePattern(jobName: string): string {
  let pattern = jobName;
  // Replace -partial or -all with -%
  pattern = pattern.replace(/-(partial|all)\b/g, "-%");
  // Strip trailing shard parenthetical
  pattern = pattern.replace(/\s*\([^)]*\)$/, "%");
  return pattern;
}

interface JobEvent {
  conclusion: string;
  fullName: string;
  htmlUrl: string;
  logUrl: string;
  startedAt: string;
  completedAt: string;
  failureCaptures: string[];
  failureLines: string[];
}

/**
 * Fetch job events for specific SHAs using exact name match.
 * Used for the PR head commit where we know the exact job name.
 */
async function fetchJobStatusExact(
  repo: string,
  jobName: string,
  shas: string[]
): Promise<Record<string, JobEvent[]>> {
  if (shas.length === 0) return {};

  const query = `
    SELECT
      job.head_sha AS sha,
      job.conclusion_kg AS conclusion,
      CONCAT(job.workflow_name, ' / ', job.name) AS fullName,
      job.html_url AS htmlUrl,
      job.log_url AS logUrl,
      job.started_at AS startedAt,
      job.completed_at AS completedAt,
      job.torchci_classification_kg.'captures'
        AS failureCaptures,
      IF(
        job.torchci_classification_kg.'line' = '',
        [],
        [job.torchci_classification_kg.'line']
      ) AS failureLines
    FROM default.workflow_job job FINAL
    WHERE
      job.id IN (
        SELECT id
        FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN ({shas: Array(String)})
      )
      AND job.head_sha IN ({shas: Array(String)})
      AND job.repository_full_name = {repo: String}
      AND CONCAT(job.workflow_name, ' / ', job.name)
        = {jobName: String}
    ORDER BY job.started_at DESC
  `;

  return groupJobRows(await queryClickhouse(query, { repo, jobName, shas }));
}

/**
 * Fetch job events for specific SHAs using LIKE pattern match.
 * Used for trunk/merge-base where job names may differ
 * (e.g. -partial on PR vs -all on trunk).
 */
async function fetchJobStatusPattern(
  repo: string,
  jobPattern: string,
  shas: string[]
): Promise<Record<string, JobEvent[]>> {
  if (shas.length === 0) return {};

  const query = `
    SELECT
      job.head_sha AS sha,
      job.conclusion_kg AS conclusion,
      CONCAT(job.workflow_name, ' / ', job.name) AS fullName,
      job.html_url AS htmlUrl,
      job.log_url AS logUrl,
      job.started_at AS startedAt,
      job.completed_at AS completedAt,
      job.torchci_classification_kg.'captures'
        AS failureCaptures,
      IF(
        job.torchci_classification_kg.'line' = '',
        [],
        [job.torchci_classification_kg.'line']
      ) AS failureLines
    FROM default.workflow_job job FINAL
    WHERE
      job.id IN (
        SELECT id
        FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN ({shas: Array(String)})
      )
      AND job.head_sha IN ({shas: Array(String)})
      AND job.repository_full_name = {repo: String}
      AND CONCAT(job.workflow_name, ' / ', job.name)
        LIKE {jobPattern: String}
    ORDER BY job.started_at DESC
  `;

  return groupJobRows(await queryClickhouse(query, { repo, jobPattern, shas }));
}

function groupJobRows(rows: any[]): Record<string, JobEvent[]> {
  const result: Record<string, JobEvent[]> = {};
  for (const row of rows) {
    const sha = row.sha as string;
    if (!result[sha]) result[sha] = [];
    result[sha].push({
      conclusion: (row.conclusion as string) || "pending",
      fullName: (row.fullName as string) || "",
      htmlUrl: row.htmlUrl as string,
      logUrl: row.logUrl as string,
      startedAt: (row.startedAt as string) || "",
      completedAt: (row.completedAt as string) || "",
      failureCaptures: (row.failureCaptures as string[]) || [],
      failureLines: (row.failureLines as string[]) || [],
    });
  }
  return result;
}

/**
 * Fetch recent trunk commit SHAs that have finished runs matching
 * the given job pattern. Returns up to `limit` distinct SHAs.
 */
async function fetchTrunkShasWithJob(
  repo: string,
  jobPattern: string,
  branch: string,
  limit: number = 5
): Promise<string[]> {
  const query = `
    SELECT DISTINCT job.head_sha AS head_sha
    FROM default.workflow_job job FINAL
    WHERE
      job.id IN (
        SELECT id FROM materialized_views.workflow_job_by_created_at
        WHERE created_at > now() - INTERVAL 3 DAY
      )
      AND job.repository_full_name = {repo: String}
      AND job.head_branch = {branch: String}
      AND CONCAT(job.workflow_name, ' / ', job.name)
        LIKE {jobPattern: String}
      AND job.conclusion_kg IN ('success', 'failure', 'cancelled', 'timed_out')
    ORDER BY job.started_at DESC
    LIMIT {limit: UInt32}
  `;
  const rows = await queryClickhouse(query, {
    repo,
    jobPattern,
    branch,
    limit,
  });
  return rows.map((r: any) => r.head_sha as string);
}

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

  // Signal key uses dr_ci_ prefix to distinguish manual HUD dispatches
  // from autorevert-system dispatches (see comment below where signalKey
  // is constructed for full rationale).
  const signalKey = `dr_ci_${jobName}`;

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
    const repoFullName = `${owner}/${repo}`;
    const botOctokit = await getOctokit(owner, repo);
    const jobPattern = jobNameToBasePattern(jobName);

    // Look up default branch (usually "main") instead of hardcoding
    const repoData = await botOctokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.data.default_branch;

    // Fetch merge base SHA from GitHub
    let resolvedMergeBase = mergeBaseSha || "";
    if (!resolvedMergeBase) {
      try {
        const compare = await botOctokit.rest.repos.compareCommits({
          owner,
          repo,
          base: defaultBranch,
          head: headSha,
        });
        resolvedMergeBase = compare.data.merge_base_commit.sha;
      } catch {
        // If compare fails (e.g. force-pushed branch), continue without merge base
      }
    }

    // Fetch trunk SHAs that actually ran this job (using pattern match)
    const trunkShas = await fetchTrunkShasWithJob(
      repoFullName,
      jobPattern,
      defaultBranch,
      3
    );

    // Fetch events: exact match for PR head, pattern match for trunk/merge-base
    const headStatus = await fetchJobStatusExact(repoFullName, jobName, [
      headSha,
    ]);

    const baseAndTrunkShas = [
      ...(resolvedMergeBase ? [resolvedMergeBase] : []),
      ...trunkShas,
    ];
    const baseAndTrunkStatus = await fetchJobStatusPattern(
      repoFullName,
      jobPattern,
      baseAndTrunkShas
    );

    const mkEvents = (status: Record<string, JobEvent[]>, sha: string) =>
      (status[sha] || []).map((e) => ({
        url: e.htmlUrl,
        log_url: e.logUrl,
        full_name: e.fullName,
        conclusion: e.conclusion,
        started_at: e.startedAt,
        completed_at: e.completedAt,
        failure_captures: e.failureCaptures,
        failure_lines: e.failureLines,
      }));

    // Derive a commit-level timestamp from the earliest event started_at
    const commitTimestamp = (
      status: Record<string, JobEvent[]>,
      sha: string
    ): string => {
      const events = status[sha] || [];
      const times = events
        .map((e) => e.startedAt)
        .filter(Boolean)
        .sort();
      return times[0] || "";
    };

    const trunkCommits = trunkShas.map((sha) => ({
      sha,
      partition: "trunk: recent main commit with this job",
      timestamp: commitTimestamp(baseAndTrunkStatus, sha),
      events: mkEvents(baseAndTrunkStatus, sha),
    }));

    // Use semantic partition names instead of failed/successful labels,
    // since the merge base or trunk commits may themselves be red.
    const signalPattern = {
      signal_key: signalKey,
      signal_source: "job",
      workflow_name: workflowName || "",
      pr_number: prNumber,
      head_sha: headSha,
      merge_base_sha: resolvedMergeBase,
      pr_head: {
        sha: headSha,
        is_suspect: true,
        timestamp: new Date().toISOString(),
        events: mkEvents(headStatus, headSha),
      },
      merge_base: resolvedMergeBase
        ? {
            sha: resolvedMergeBase,
            timestamp: commitTimestamp(baseAndTrunkStatus, resolvedMergeBase),
            events: mkEvents(baseAndTrunkStatus, resolvedMergeBase),
          }
        : null,
      trunk: trunkCommits,
    };

    await botOctokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: "claude-autorevert-advisor.yml",
      ref: defaultBranch,
      inputs: {
        suspect_commit: headSha,
        pr_number: String(prNumber),
        signal_pattern: JSON.stringify(signalPattern),
      },
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
