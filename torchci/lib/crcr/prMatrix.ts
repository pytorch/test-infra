// Row-building for the CRCR pull-request matrix. A row represents one
// downstream workflow run, so every displayed job URL belongs to that run.

export interface PrMatrixJob {
  upstream_repo?: string;
  pr_number?: number;
  pytorch_head_sha: string;
  job_name: string;
  run_id: string;
  run_attempt: number;
  started_at: string;
}

export interface PrMatrixRow<T extends PrMatrixJob = PrMatrixJob> {
  prNumber: number;
  runId: string;
  sha: string;
  upstreamRepo: string;
  latestTime: string;
  jobs: Map<string, T>;
}

interface RunGroup<T extends PrMatrixJob> {
  prNumber: number;
  runId: string;
  sha: string;
  upstreamRepo: string;
  firstStartedAt: string;
  latestStartedAt: string;
  jobs: T[];
}

function isNewerRun<T extends PrMatrixJob>(
  candidate: RunGroup<T>,
  current: RunGroup<T>
): boolean {
  if (candidate.firstStartedAt !== current.firstStartedAt) {
    return candidate.firstStartedAt > current.firstStartedAt;
  }
  if (candidate.latestStartedAt !== current.latestStartedAt) {
    return candidate.latestStartedAt > current.latestStartedAt;
  }
  return candidate.runId > current.runId;
}

/**
 * Build one row per PR from its most recently started downstream workflow.
 *
 * A retry increases run_attempt only inside its own run_id. Selecting the run
 * before selecting job attempts prevents an older run's retry from replacing
 * a cell in a newer run and sending users to the wrong workflow URL.
 */
export function buildPrMatrix<T extends PrMatrixJob>(data: T[]): {
  jobNames: string[];
  rows: PrMatrixRow<T>[];
} {
  const jobNames = new Set<string>();
  const runGroups = new Map<string, RunGroup<T>>();

  for (const job of data) {
    const prNumber = job.pr_number ?? 0;
    if (prNumber <= 0) continue;

    jobNames.add(job.job_name);
    const key = `${prNumber}:${job.pytorch_head_sha}:${job.run_id}`;
    let group = runGroups.get(key);
    if (!group) {
      group = {
        prNumber,
        runId: job.run_id,
        sha: job.pytorch_head_sha,
        upstreamRepo: job.upstream_repo ?? "pytorch/pytorch",
        firstStartedAt: job.started_at,
        latestStartedAt: job.started_at,
        jobs: [],
      };
      runGroups.set(key, group);
    }

    group.firstStartedAt =
      job.started_at < group.firstStartedAt
        ? job.started_at
        : group.firstStartedAt;
    group.latestStartedAt =
      job.started_at > group.latestStartedAt
        ? job.started_at
        : group.latestStartedAt;
    group.jobs.push(job);
  }

  const latestRunByPr = new Map<number, RunGroup<T>>();
  for (const group of runGroups.values()) {
    const current = latestRunByPr.get(group.prNumber);
    if (!current || isNewerRun(group, current)) {
      latestRunByPr.set(group.prNumber, group);
    }
  }

  const rows = Array.from(latestRunByPr.values())
    .map((group) => {
      const jobs = new Map<string, T>();
      for (const job of group.jobs) {
        const existing = jobs.get(job.job_name);
        if (
          !existing ||
          job.run_attempt > existing.run_attempt ||
          (job.run_attempt === existing.run_attempt &&
            job.started_at > existing.started_at)
        ) {
          jobs.set(job.job_name, job);
        }
      }

      return {
        prNumber: group.prNumber,
        runId: group.runId,
        sha: group.sha,
        upstreamRepo: group.upstreamRepo,
        latestTime: group.latestStartedAt,
        jobs,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime()
    );

  return { jobNames: Array.from(jobNames).sort(), rows };
}
