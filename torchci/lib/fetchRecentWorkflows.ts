import { queryClickhouse, queryClickhouseSaved } from "./clickhouse";
import { withoutControlMarkers } from "./crcr/crcrComment";
import { RecentWorkflowsData } from "./types";

export async function fetchRecentWorkflows(
  repo: string = "pytorch/pytorch",
  prNumbers: Array<number> = [],
  numMinutes: string = "30"
): Promise<RecentWorkflowsData[]> {
  return await queryClickhouseSaved("recent_pr_workflows_query", {
    numMinutes,
    prNumbers,
    repo,
  });
}

export async function fetchCrcrWorkflows(
  repo: string = "pytorch/pytorch",
  prNumbers: Array<number> = []
): Promise<RecentWorkflowsData[]> {
  // Query the crcr_workflow_job table for CRCR downstream CI jobs on open PRs.
  // Map columns to RecentWorkflowsData shape so Dr.CI can classify them.
  //
  // Every job that reported is returned, passing and still-running ones
  // included: the rendered section reports "N of M jobs failed", and a job that
  // is still running is one of the M but not one that passed. Failures are the
  // only rows that reach a Dr.CI bucket -- isCrCrFailure decides that on the
  // conclusion -- so the extra rows cost one query result, not a verdict. A job
  // that has not reported at all has no row here, so M is what the repo has
  // reported rather than the size of the matrix.
  const rows = await queryClickhouse(
    `SELECT
      workflow_name AS name,
      job_name AS jobName,
      pr_number,
      check_run_id AS id,
      conclusion,
      completed_at,
      workflow_run_url AS html_url,
      pytorch_head_sha AS head_sha,
      downstream_repo,
      downstream_repo_level,
      triage_verdict_json,
      run_attempt,
      run_id
    FROM default.crcr_workflow_job
    WHERE upstream_repo = {repo:String}
      AND pr_number IN ({prNumbers:Array(UInt64)})`,
    { repo, prNumbers: prNumbers.length > 0 ? prNumbers : [0] }
  );

  return rows.map((row: any) => ({
    // The check run name. Its workflow and job halves come from the downstream
    // callback, and the name is rendered into the Dr. CI comment both by the
    // grouped CRCR section and by the generic list the section falls back to
    // (pages/api/drci/drci.ts), where the section's own delimiters and pin
    // markers are parsed back out of the body. Defusing the control strings here
    // covers every consumer at once -- including the failures JSON that goes
    // into the Dr. CI check run summary -- so no later renderer has to remember.
    name: withoutControlMarkers(
      `crcr/${row.downstream_repo}/${row.name}/${row.jobName || row.name}`
    ),
    jobName: row.jobName || row.name,
    workflowId: 0,
    workflowUniqueId: 0,
    id: parseInt(row.id) || 0,
    completed_at: row.completed_at || "",
    // Also callback-supplied, and also rendered into that comment.
    html_url: withoutControlMarkers(row.html_url || ""),
    head_sha: row.head_sha || "",
    head_sha_timestamp: "",
    head_branch: "",
    pr_number: parseInt(row.pr_number) || 0,
    // An empty conclusion stays empty: the query no longer filters on
    // conclusion, and a job that reported completed without one is not a failure.
    // Nothing else calls it one -- the relay passes the callback's conclusion
    // straight through (utils/gh_helper.py only sets one when the callback sent
    // it), and the query filtered these rows out entirely before this change.
    // Defaulting it to "failure" here would render a red job, and for L4 a
    // blocking one, that nothing agrees with. isCrCrFailure in drci.ts decides.
    // Defusing cannot change a real conclusion, so the classification is safe.
    conclusion: withoutControlMarkers(row.conclusion || ""),
    failure_captures: [],
    failure_lines: [],
    failure_context: [],
    downstreamLevel: row.downstream_repo_level || "",
    downstreamRepo: row.downstream_repo || "",
    triageVerdictJson: row.triage_verdict_json || "",
    runAttempt: Number(row.run_attempt ?? 1) || 1,
    // The run a row's attempt belongs to: run_attempt starts over at 1 for each
    // new run, so the two together place the row. 0 is "no run named", which
    // latestAttemptPerJob sorts with the oldest.
    runId: Number(row.run_id) || 0,
  }));
}

export async function fetchCrcrActivityPRs(
  repo: string = "pytorch/pytorch",
  numMinutes: string = "30"
): Promise<number[]> {
  // The PRs the relay reported on recently, by row write time. A CRCR row is
  // not upstream workflow activity, so the sweep otherwise never visits a PR
  // whose only fresh signal is a downstream callback -- a failure landing
  // after upstream CI has gone quiet would sit unreported until something else
  // woke the PR. _inserted_at is the row's write time: the in_progress write
  // and the completed rewrite of the same key both refresh it, so a matrix
  // keeps its PR wakeable for as long as it reports. Filtering on the
  // conclusion or the status would blind the wake to exactly those runs.
  // Rows only exist once the relay has heard from a job (queued jobs write
  // none), so this wakes on what is observable, not on what is queued.
  //
  // No FINAL: duplicates of one key collapse in the DISTINCT, and skipping the
  // merge keeps the read off the merges. An in-flight job's PR is also kept
  // wakeable by the in-flight sentinel the sweep writes into its comment; this
  // query is what gives that sentinel its first sweep.
  const rows = await queryClickhouse(
    `SELECT DISTINCT pr_number
    FROM default.crcr_workflow_job
    WHERE upstream_repo = {repo:String}
      AND _inserted_at > now() - INTERVAL {numMinutes:Int64} MINUTE`,
    { repo, numMinutes: parseInt(numMinutes, 10) }
  );
  // A row without a PR cannot wake one.
  return rows
    .map((row: any) => parseInt(row.pr_number) || 0)
    .filter((pr: number) => pr > 0);
}

export async function fetchFailedJobsFromCommits(
  shas: string[]
): Promise<RecentWorkflowsData[]> {
  return await queryClickhouseSaved("commit_failed_jobs", {
    shas,
  });
}

export async function fetchJobNamesFromCommits(
  shas: string[]
): Promise<{ head_sha: string; name: string }[]> {
  return await queryClickhouseSaved("commit_job_names", {
    shas,
  });
}
