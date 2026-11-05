export interface CrcrRunSelectionJob {
  prNumber: number;
  headSha: string;
  downstreamRepo: string;
  runId: string;
  runAttempt: number;
  jobKey: string;
  startedAt: string;
  recordId: string;
}

export interface CanonicalCrcrRun<T extends CrcrRunSelectionJob> {
  prNumber: number;
  headSha: string;
  downstreamRepo: string;
  runId: string;
  firstStartedAt: string;
  latestStartedAt: string;
  jobs: T[];
}

function isNewerRun<T extends CrcrRunSelectionJob>(
  candidate: CanonicalCrcrRun<T>,
  current: CanonicalCrcrRun<T>
): boolean {
  if (candidate.firstStartedAt !== current.firstStartedAt) {
    return candidate.firstStartedAt > current.firstStartedAt;
  }
  if (candidate.latestStartedAt !== current.latestStartedAt) {
    return candidate.latestStartedAt > current.latestStartedAt;
  }
  return candidate.runId > current.runId;
}

function latestAttempt<T extends CrcrRunSelectionJob>(
  candidate: T,
  current: T
): boolean {
  if (candidate.runAttempt !== current.runAttempt) {
    return candidate.runAttempt > current.runAttempt;
  }
  if (candidate.startedAt !== current.startedAt) {
    return candidate.startedAt > current.startedAt;
  }
  return candidate.recordId > current.recordId;
}

function runScope(job: CrcrRunSelectionJob): string {
  return `${job.prNumber}:${job.headSha}:${job.downstreamRepo}`;
}

/**
 * Select one newest downstream workflow run for each PR, head SHA, and backend.
 */
export function selectCanonicalCrcrRuns<T extends CrcrRunSelectionJob>(
  jobs: T[]
): CanonicalCrcrRun<T>[] {
  const runs = new Map<string, CanonicalCrcrRun<T>>();

  for (const job of jobs) {
    const key = `${runScope(job)}:${job.runId}`;
    let run = runs.get(key);
    if (!run) {
      run = {
        prNumber: job.prNumber,
        headSha: job.headSha,
        downstreamRepo: job.downstreamRepo,
        runId: job.runId,
        firstStartedAt: job.startedAt,
        latestStartedAt: job.startedAt,
        jobs: [],
      };
      runs.set(key, run);
    }
    run.firstStartedAt =
      job.startedAt < run.firstStartedAt ? job.startedAt : run.firstStartedAt;
    run.latestStartedAt =
      job.startedAt > run.latestStartedAt ? job.startedAt : run.latestStartedAt;
    run.jobs.push(job);
  }

  const canonicalByScope = new Map<string, CanonicalCrcrRun<T>>();
  for (const run of runs.values()) {
    const current = canonicalByScope.get(
      `${run.prNumber}:${run.headSha}:${run.downstreamRepo}`
    );
    if (!current || isNewerRun(run, current)) {
      canonicalByScope.set(
        `${run.prNumber}:${run.headSha}:${run.downstreamRepo}`,
        run
      );
    }
  }

  return Array.from(canonicalByScope.values());
}

/**
 * Keep each job's final attempt inside its canonical downstream workflow run.
 */
export function selectFinalCrcrJobAttempts<T extends CrcrRunSelectionJob>(
  jobs: T[]
): T[] {
  const jobsByKey = new Map<string, T>();
  for (const job of jobs) {
    const current = jobsByKey.get(job.jobKey);
    if (!current || latestAttempt(job, current)) {
      jobsByKey.set(job.jobKey, job);
    }
  }
  return Array.from(jobsByKey.values());
}

export function selectCanonicalCrcrJobs<T extends CrcrRunSelectionJob>(
  jobs: T[]
): T[] {
  return selectCanonicalCrcrRuns(jobs).flatMap((run) =>
    selectFinalCrcrJobAttempts(run.jobs)
  );
}

/**
 * Preserve legacy rows without a head SHA only when this head has no result for
 * that job. Then select a canonical run for each remaining result scope.
 */
export function selectCurrentHeadCrcrJobs<T extends CrcrRunSelectionJob>(
  jobs: T[],
  headSha: string
): T[] {
  const matching = jobs.filter(
    (job) => job.headSha === headSha || job.headSha === ""
  );
  const knownKeys = new Set(
    matching
      .filter((job) => job.headSha === headSha)
      .map((job) => `${job.downstreamRepo}:${job.jobKey}`)
  );

  return selectCanonicalCrcrJobs(
    matching.filter(
      (job) =>
        job.headSha === headSha ||
        !knownKeys.has(`${job.downstreamRepo}:${job.jobKey}`)
    )
  );
}
