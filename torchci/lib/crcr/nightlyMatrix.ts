// Row-building for the CRCR nightly matrix, extracted from the repo page so
// it can be unit tested.

// The subset of a nightly job row the matrix needs. Structural, so the page's
// wider CrcrJobRow satisfies it without importing anything from pages/.
export interface NightlyMatrixJob {
  job_name: string;
  run_id: string;
  pytorch_head_sha: string;
  upstream_repo?: string;
  started_at: string;
  run_attempt: number;
  conclusion?: string;
}

export interface NightlyRow<T extends NightlyMatrixJob = NightlyMatrixJob> {
  // What the row was grouped on: the commit when there is one, else the run.
  key: string;
  runId: string;
  sha: string;
  upstreamRepo: string;
  latestTime: string;
  jobs: Map<string, T>;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

// Nightly reporters that send no upstream commit fall back to their
// delivery_id, so pytorch_head_sha can hold something like
// "buildkite-89983-<uuid>". Linking that to github.com/pytorch/pytorch/commit/
// yields a 404, so callers use this to decide whether the commit cell is
// meaningful.
export function isRealCommitSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

// Worst-first, so a column that collapses several same-named jobs reports the
// most severe outcome rather than whichever happened to be last.
const CONCLUSION_SEVERITY: Record<string, number> = {
  failure: 5,
  timed_out: 4,
  cancelled: 3,
  skipped: 2,
  success: 1,
};

function severity(job: NightlyMatrixJob): number {
  return CONCLUSION_SEVERITY[job.conclusion ?? ""] ?? 0;
}

/**
 * Group nightly jobs into one row per upstream commit.
 *
 * A commit is the right unit: repos routinely run several workflows against
 * one pytorch nightly (NVIDIA/pytorch-windows-ci reports 10 commits across 19
 * runs, TorchedHat/pytorch-redhat-ci 30 across 73), and those belong on one
 * row so the stages sit side by side.
 *
 * That only works while pytorch_head_sha holds a commit. A nightly that
 * reports none falls back to its delivery_id, which is per-job -- vllm-project
 * /vllm's 65-job build had 65 distinct "SHAs" and rendered as 65 single-cell
 * rows. For those, fall back to run_id, which is what
 * crcr_nightly_dashboard/query.sql already treats as a run (eligible_runs,
 * latest_attempts, and the final (run_id, job_name, run_attempt) filter).
 *
 * So: group by commit where there is one, by run where there is not. Repos
 * that report a real SHA keep exactly the behaviour they had.
 */
export function buildNightlyMatrix<T extends NightlyMatrixJob>(
  data: T[]
): { jobNames: string[]; rows: NightlyRow<T>[] } {
  const jobNamesSet = new Set<string>();
  const runMap = new Map<string, NightlyRow<T>>();

  for (const job of data) {
    jobNamesSet.add(job.job_name);
    const sha = job.pytorch_head_sha || "unknown";
    const key = isRealCommitSha(sha) ? sha : job.run_id || sha;
    let row = runMap.get(key);
    if (!row) {
      row = {
        key,
        runId: job.run_id,
        sha,
        upstreamRepo: job.upstream_repo ?? "pytorch/pytorch",
        latestTime: job.started_at,
        jobs: new Map(),
      };
      runMap.set(key, row);
    }
    if (job.started_at > row.latestTime) {
      row.latestTime = job.started_at;
    }
    const existing = row.jobs.get(job.job_name);
    // A build can run several jobs under one label (parallel shards). Grouping
    // by run puts them in a single cell, so prefer the later attempt and then
    // the worse outcome -- otherwise a failing shard can be hidden behind a
    // passing sibling that merely sorted last.
    if (
      !existing ||
      job.run_attempt > existing.run_attempt ||
      (job.run_attempt === existing.run_attempt &&
        severity(job) > severity(existing))
    ) {
      row.jobs.set(job.job_name, job);
    }
  }

  const jobNames = Array.from(jobNamesSet).sort();
  const rows = Array.from(runMap.values()).sort(
    (a, b) =>
      new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime()
  );
  return { jobNames, rows };
}
