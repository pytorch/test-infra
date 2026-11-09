import {
  CanonicalCrcrRun,
  CrcrRunSelectionJob,
  selectCanonicalCrcrRuns,
  selectFinalCrcrJobAttempts,
} from "lib/crcr/runSelection";

export interface PrMatrixJob {
  upstream_repo?: string;
  pr_number?: number;
  pytorch_head_sha: string;
  job_name: string;
  check_run_id?: string;
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

interface MatrixSelectionJob<T extends PrMatrixJob>
  extends CrcrRunSelectionJob {
  source: T;
}

function isNewerRun<T extends PrMatrixJob>(
  candidate: CanonicalCrcrRun<MatrixSelectionJob<T>>,
  current: CanonicalCrcrRun<MatrixSelectionJob<T>>
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
export function buildPrMatrix<T extends PrMatrixJob>(
  data: T[]
): {
  jobNames: string[];
  rows: PrMatrixRow<T>[];
} {
  const jobNames = new Set<string>();
  const selectionJobs: MatrixSelectionJob<T>[] = [];
  for (const job of data) {
    const prNumber = job.pr_number ?? 0;
    if (prNumber <= 0) continue;

    jobNames.add(job.job_name);
    selectionJobs.push({
      source: job,
      prNumber,
      headSha: job.pytorch_head_sha,
      downstreamRepo: "",
      runId: job.run_id,
      runAttempt: job.run_attempt,
      jobKey: job.job_name,
      startedAt: job.started_at,
      recordId: job.check_run_id ?? "",
    });
  }

  const latestRunByPr = new Map<
    number,
    CanonicalCrcrRun<MatrixSelectionJob<T>>
  >();
  for (const run of selectCanonicalCrcrRuns(selectionJobs)) {
    const current = latestRunByPr.get(run.prNumber);
    if (!current || isNewerRun(run, current)) {
      latestRunByPr.set(run.prNumber, run);
    }
  }

  const rows = Array.from(latestRunByPr.values())
    .map((run) => {
      const jobs = new Map<string, T>();
      for (const selected of selectFinalCrcrJobAttempts(run.jobs)) {
        jobs.set(selected.jobKey, selected.source);
      }

      return {
        prNumber: run.prNumber,
        runId: run.runId,
        sha: run.headSha,
        upstreamRepo: run.jobs[0].source.upstream_repo ?? "pytorch/pytorch",
        latestTime: run.latestStartedAt,
        jobs,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime()
    );

  return { jobNames: Array.from(jobNames).sort(), rows };
}
