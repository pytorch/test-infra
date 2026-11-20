import {
  CrcrRunSelectionJob,
  selectCurrentHeadCrcrJobs,
} from "lib/crcr/runSelection";

export interface CrcrHudResult {
  pr_number: number;
  pytorch_head_sha: string;
  downstream_repo: string;
  job_name: string;
  check_run_id: string;
  run_id: string;
  run_attempt: number;
  started_at: string;
}

interface HudSelectionJob<T extends CrcrHudResult> extends CrcrRunSelectionJob {
  source: T;
}

export function selectHudCrcrResults<T extends CrcrHudResult>(
  rows: T[],
  headSha: string
): T[] {
  const jobs: HudSelectionJob<T>[] = rows.map((row) => ({
    source: row,
    prNumber: row.pr_number,
    headSha: row.pytorch_head_sha,
    downstreamRepo: row.downstream_repo,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    jobKey: row.job_name,
    startedAt: row.started_at,
    recordId: row.check_run_id,
  }));

  return selectCurrentHeadCrcrJobs(jobs, headSha).map((job) => job.source);
}
