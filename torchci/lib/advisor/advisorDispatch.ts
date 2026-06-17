// Shared AI advisor dispatch logic.
//
// Extracted from the manual "AI Analyze" endpoint (pull/dispatch-advisor.ts) so
// the signal_pattern build + workflow dispatch can be reused by other callers.
// Behavior-preserving: this is the same logic the manual endpoint already ran.

import { queryClickhouseSaved } from "lib/clickhouse";
import { getOctokit } from "lib/github";

// The advisor workflow_dispatch file on the repo's default branch.
const ADVISOR_WORKFLOW_FILE = "claude-autorevert-advisor.yml";

const SHA_REGEX = /^[0-9a-f]{7,40}$/i;

export function isValidSha(sha: string): boolean {
  return SHA_REGEX.test(sha);
}

/**
 * The signal_key convention for HUD-originated advisor dispatches. The dr_ci_
 * prefix distinguishes these from autorevert-system dispatches. `fullJobName` is
 * the "Workflow / job" display string.
 */
export function signalKeyForJob(fullJobName: string): string {
  return `dr_ci_${fullJobName}`;
}

/**
 * Derive a LIKE pattern from a HUD job name that matches both PR variants
 * (-partial) and trunk variants (-all), and strips shard parentheticals.
 * E.g. "Lint / lintrunner-pyrefly-partial / lint"
 *   -> "Lint / lintrunner-pyrefly-% / lint"
 */
function jobNameToBasePattern(jobName: string): string {
  let pattern = jobName;
  pattern = pattern.replace(/-(partial|all)\b/g, "-%");
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

/** Fetch job events for specific SHAs using exact name match (PR head). */
async function fetchJobStatusExact(
  repo: string,
  jobName: string,
  shas: string[]
): Promise<Record<string, JobEvent[]>> {
  if (shas.length === 0) return {};
  return groupJobRows(
    await queryClickhouseSaved("advisor_job_status_exact", {
      repo,
      jobName,
      shas,
    })
  );
}

/** Fetch job events for specific SHAs using LIKE pattern (trunk/merge-base). */
async function fetchJobStatusPattern(
  repo: string,
  jobPattern: string,
  shas: string[]
): Promise<Record<string, JobEvent[]>> {
  if (shas.length === 0) return {};
  return groupJobRows(
    await queryClickhouseSaved("advisor_job_status_pattern", {
      repo,
      jobPattern,
      shas,
    })
  );
}

/** Recent trunk SHAs with finished runs matching the job pattern. */
async function fetchTrunkShasWithJob(
  repo: string,
  jobPattern: string,
  branch: string,
  limit: number = 5
): Promise<string[]> {
  const rows = await queryClickhouseSaved("advisor_trunk_shas_with_job", {
    repo,
    jobPattern,
    branch,
    limit,
  });
  return rows.map((r: any) => r.head_sha as string);
}

export interface DispatchParams {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  // The full "Workflow / job" name. Used to build the signal_key and match
  // CH job rows.
  jobName: string;
  mergeBaseSha?: string;
  workflowName?: string;
}

/**
 * Dispatch one advisor analysis as the bot. Builds the signal_pattern (PR head +
 * merge base + recent trunk runs of the same job) and triggers the advisor
 * workflow. Throws on failure so the caller can map it to an HTTP error.
 */
export async function dispatchAdvisorWorkflow(
  params: DispatchParams
): Promise<void> {
  const { owner, repo, prNumber, headSha, jobName } = params;
  const repoFullName = `${owner}/${repo}`;
  const botOctokit = await getOctokit(owner, repo);
  const jobPattern = jobNameToBasePattern(jobName);

  // Look up default branch (usually "main") instead of hardcoding
  const repoData = await botOctokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.data.default_branch;

  // Fetch merge base SHA from GitHub
  let resolvedMergeBase = params.mergeBaseSha || "";
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
    signal_key: signalKeyForJob(jobName),
    signal_source: "job",
    workflow_name: params.workflowName || "",
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
    workflow_id: ADVISOR_WORKFLOW_FILE,
    ref: defaultBranch,
    inputs: {
      suspect_commit: headSha,
      pr_number: String(prNumber),
      signal_pattern: JSON.stringify(signalPattern),
    },
  });
}
