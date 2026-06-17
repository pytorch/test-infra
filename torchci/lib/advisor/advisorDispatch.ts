// Shared AI advisor dispatch + auto-dispatch logic.
//
// dispatchAdvisorWorkflow (the signal_pattern build + workflow dispatch) is
// shared with the manual "AI Analyze" endpoint (pull/dispatch-advisor.ts). The
// rest -- the misc.ai_advisor_dispatches dedup/retry state and the
// autoDispatchAdvisorForNewFailures loop -- backs the automatic Dr.CI path.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  getAdvisorRepoConfig,
  getMaxNewFailures,
} from "lib/advisor/advisorConfig";
import {
  getClickhouseClientWritable,
  queryClickhouseSaved,
} from "lib/clickhouse";
import { CANCELLED_STEP_ERROR } from "lib/drciUtils";
import { getOctokit } from "lib/github";
import { RecentWorkflowsData } from "lib/types";

dayjs.extend(utc);

const DISPATCH_TABLE = "misc.ai_advisor_dispatches";

// Max times we re-attempt a dispatch whose workflow_dispatch POST threw. Bounds
// the retry so a permanently-failing dispatch cannot re-attempt every cron pass.
export const MAX_DISPATCH_RETRIES = 3;

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
 * merge base + recent trunk runs of the same job) and triggers the per-repo
 * advisor workflow. Throws on failure so the caller can map it to an HTTP error.
 *
 * Note: GitHub's POST /actions/workflows/{id}/dispatches is not idempotent (it
 * can create the run and then return 5xx on the response), and the default
 * Octokit retry plugin would retry the POST and create duplicate runs -- so we
 * pass `request: { retries: 0 }` to disable auto-retry on the dispatch.
 */
export async function dispatchAdvisorWorkflow(
  params: DispatchParams
): Promise<void> {
  const { owner, repo, prNumber, headSha, jobName } = params;
  const cfg = getAdvisorRepoConfig(owner, repo);
  if (!cfg) {
    throw new Error(`AI advisor is not enabled for ${owner}/${repo}`);
  }
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
    workflow_id: cfg.workflowFile,
    ref: defaultBranch,
    inputs: {
      suspect_commit: headSha,
      pr_number: String(prNumber),
      signal_pattern: JSON.stringify(signalPattern),
    },
    // Storm guard: never auto-retry the non-idempotent dispatch POST.
    request: { retries: 0 },
  });
}

export type DispatchState = "dispatching" | "dispatched" | "failed";

interface DispatchStateRow {
  state: DispatchState;
  retryCount: number;
}

/**
 * Read the latest dispatch state per signal_key for one PR head. argMax over the
 * replacing version returns the latest row without a FINAL merge. Filters on the
 * (owner, repo, head_sha) ORDER BY prefix, so it touches only relevant granules.
 */
export async function readDispatchStates(
  owner: string,
  repo: string,
  headSha: string,
  signalKeys: string[]
): Promise<Map<string, DispatchStateRow>> {
  const result = new Map<string, DispatchStateRow>();
  if (signalKeys.length === 0) return result;

  // Reads state + retry_count from the SAME latest row as one argMax tuple, so
  // a shared version timestamp can't pair fields from different rows.
  const rows = await queryClickhouseSaved("advisor_dispatch_states", {
    owner,
    repo,
    headSha,
    signalKeys,
  });

  for (const row of rows) {
    // ClickHouse returns a tuple as a positional array: [state, retry_count].
    const sr = row.sr as [string, number];
    result.set(row.signal_key as string, {
      state: sr[0] as DispatchState,
      retryCount: Number(sr[1] ?? 0),
    });
  }
  return result;
}

export interface DispatchRecord {
  owner: string;
  repo: string;
  headSha: string;
  signalKey: string;
  state: DispatchState;
  retryCount: number;
  prNumber: number;
  jobName: string;
}

// Monotonic version generator. The ReplacingMergeTree keeps the row with the
// max `version` per key, and reads pick it with argMax(version); on a version
// TIE that choice is non-deterministic. The pre-dispatch ('dispatching') and
// terminal ('dispatched'/'failed') rows for one dispatch are written from the
// same process microseconds apart and could share a millisecond, which would
// let a 'dispatching' row mask a terminal one (e.g. a fast-failing dispatch
// would never retry). Clamp to strictly-increasing-per-process so the terminal
// write always outranks its pre-dispatch write.
let lastVersionMs = 0;
function nextDispatchVersion(): string {
  let ms = dayjs().valueOf();
  if (ms <= lastVersionMs) ms = lastVersionMs + 1;
  lastVersionMs = ms;
  return dayjs(ms).utc().format("YYYY-MM-DD HH:mm:ss.SSS");
}

/** Insert one row into the dispatch log. ReplacingMergeTree collapses by key. */
export async function recordDispatch(record: DispatchRecord): Promise<void> {
  await getClickhouseClientWritable().insert({
    table: DISPATCH_TABLE,
    values: [
      {
        owner: record.owner,
        repo: record.repo,
        head_sha: record.headSha,
        signal_key: record.signalKey,
        state: record.state,
        retry_count: record.retryCount,
        pr_number: record.prNumber,
        job_name: record.jobName,
        version: nextDispatchVersion(),
      },
    ],
    format: "JSONEachRow",
  });
}

// Injectable dependencies so the orchestration logic is unit-testable without
// touching ClickHouse or GitHub.
export interface AutoDispatchDeps {
  readDispatchStates: typeof readDispatchStates;
  recordDispatch: typeof recordDispatch;
  dispatchAdvisorWorkflow: typeof dispatchAdvisorWorkflow;
}

const defaultDeps: AutoDispatchDeps = {
  readDispatchStates,
  recordDispatch,
  dispatchAdvisorWorkflow,
};

export interface AutoDispatchArgs {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  mergeBaseSha?: string;
  // The FAILED bucket from Dr.CI (RecentWorkflowsData[]). Cancelled jobs are
  // filtered out here so only true NEW failures are dispatched.
  newFailures: RecentWorkflowsData[];
}

/** Whether auto-dispatch is enabled for this environment + repo. */
export function autoDispatchEnabled(owner: string, repo: string): boolean {
  return (
    process.env.DRCI_ADVISOR_AUTODISPATCH_ENABLED === "true" &&
    process.env.VERCEL_ENV === "production" &&
    getAdvisorRepoConfig(owner, repo) !== undefined
  );
}

/**
 * Automatically dispatch the AI advisor on a PR's NEW failures.
 *
 * Dispatch-only: this never edits the Dr.CI comment or merge behavior. Behavior:
 *   - gated by feature flag + production env + per-repo config (no-op otherwise),
 *   - fails CLOSED: if the dedup read throws (CH down) we dispatch nothing,
 *   - two-phase write: a 'dispatching' row is written BEFORE the dispatch and
 *     gates it (if that write throws, the write path is down -- we abort the PR
 *     rather than dispatch without a dedup record),
 *   - 'dispatched' is written on success; a 'failed' row supersedes the pre row
 *     when the dispatch throws, re-enabling retry up to MAX_DISPATCH_RETRIES,
 *   - bails entirely (dispatches nothing) if a PR has more NEW failures than the
 *     per-repo max (outage guard).
 */
export async function autoDispatchAdvisorForNewFailures(
  args: AutoDispatchArgs,
  deps: AutoDispatchDeps = defaultDeps
): Promise<void> {
  const { owner, repo, prNumber, headSha, mergeBaseSha } = args;

  if (!autoDispatchEnabled(owner, repo)) return;
  if (!isValidSha(headSha)) return;

  // True NEW failures only -- mirror constructResultsComment's cancelled filter.
  const candidates = args.newFailures.filter(
    (job) =>
      job.conclusion !== "cancelled" &&
      !(job.failure_captures || []).includes(CANCELLED_STEP_ERROR)
  );
  if (candidates.length === 0) return;

  // One entry per signal_key (a job can appear once); preserve first occurrence.
  const byKey = new Map<string, RecentWorkflowsData>();
  for (const job of candidates) {
    if (!job.name) continue;
    const key = signalKeyForJob(job.name);
    if (!byKey.has(key)) byKey.set(key, job);
  }
  const signalKeys = Array.from(byKey.keys());
  if (signalKeys.length === 0) return;

  // Outage guard: if a PR has more NEW failures than the per-repo max, bail
  // entirely (dispatch nothing). A flood of new failures is almost always an
  // outage, not a PR problem, and we don't want to fan dozens of advisor runs
  // out across one PR.
  const maxNewFailures = getMaxNewFailures(owner, repo);
  if (byKey.size > maxNewFailures) {
    console.log(
      `advisor auto-dispatch: PR ${prNumber} has ${byKey.size} new failures ` +
        `(> ${maxNewFailures}); skipping auto-dispatch (likely an outage)`
    );
    return;
  }

  // Fail closed: if we cannot read dedup state, dispatch nothing.
  let states: Map<string, DispatchStateRow>;
  try {
    states = await deps.readDispatchStates(owner, repo, headSha, signalKeys);
  } catch (e) {
    console.error(
      `advisor auto-dispatch: dedup read failed for PR ${prNumber}, skipping pass`,
      e
    );
    return;
  }

  // The byKey set is already bounded by the outage guard above (<= the per-repo
  // max), so dispatch every fresh failure; dedup state skips repeats.
  for (const [signalKey, job] of byKey) {
    const prev = states.get(signalKey);
    if (prev) {
      // Already dispatching or completed -> permanent skip.
      if (prev.state === "dispatching" || prev.state === "dispatched") continue;
      // Failed and out of retries -> permanent skip.
      if (prev.state === "failed" && prev.retryCount >= MAX_DISPATCH_RETRIES) {
        continue;
      }
    }
    const retryCount = prev?.state === "failed" ? prev.retryCount + 1 : 0;

    const base = {
      owner,
      repo,
      headSha,
      signalKey,
      retryCount,
      prNumber,
      jobName: job.name,
    };

    // Pre-dispatch write gates the dispatch on write-path health: if we cannot
    // record the marker (e.g. bad write creds) we must NOT dispatch, otherwise
    // a later verdict-write failure would re-dispatch forever. The same creds
    // fail for every key, so abort the whole PR.
    try {
      await deps.recordDispatch({ ...base, state: "dispatching" });
    } catch (e) {
      console.error(
        `advisor auto-dispatch: pre-dispatch write failed for PR ${prNumber}, aborting`,
        e
      );
      return;
    }

    try {
      await deps.dispatchAdvisorWorkflow({
        owner,
        repo,
        prNumber,
        headSha,
        mergeBaseSha,
        jobName: job.name,
        workflowName: job.name.split(" / ")[0],
      });
    } catch (e) {
      console.error(
        `advisor auto-dispatch: dispatch failed for PR ${prNumber} ${signalKey}`,
        e
      );
      // Supersede the pre-dispatch row so it is retryable next pass.
      try {
        await deps.recordDispatch({ ...base, state: "failed" });
      } catch (e2) {
        console.error("advisor auto-dispatch: failed-state write failed", e2);
      }
      continue;
    }

    // Confirm completion. If this write throws, the 'dispatching' row already
    // blocks re-dispatch, so the only cost is losing the explicit confirmation.
    try {
      await deps.recordDispatch({ ...base, state: "dispatched" });
    } catch (e) {
      console.error(
        "advisor auto-dispatch: post-dispatch write failed (non-fatal)",
        e
      );
    }
  }
}
