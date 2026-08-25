import fetchCommit from "lib/fetchCommit";
import { CommitData, JobData } from "lib/types";
import type { NextApiRequest, NextApiResponse } from "next";

export type WorkflowRunInfo = {
  id: number;
  attempt: number;
  // Carried so the workflow picker can name a run rather than offer bare numeric ids a reader
  // cannot tell apart. Same spellings as JobData: "autorevert" for a restart dispatched against a
  // trunk/<sha> ref, "retry" for a re-run attempt.
  // `null`, not just optional: commit_jobs_query ships a real SQL NULL for an ordinary push, and
  // typing it `string | undefined` would have been a lie the runtime never tells.
  runOrigin?: string | null;
};

export type CommitApiResponse = {
  commit: CommitData;
  jobs: JobData[];
  workflowIdsByName: Record<string, [WorkflowRunInfo]>;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CommitApiResponse>
) {
  const workflowId = parseInt(req.query.workflowId as string, 10) || 0;
  const runAttempt = parseInt(req.query.runAttempt as string, 10) || 0;
  const data = await fetchCommit(
    req.query.repoOwner as string,
    req.query.repoName as string,
    req.query.sha as string,
    workflowId,
    runAttempt
  );
  // Short TTL because the response bundles live CI job data with the immutable commit metadata.
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=240");
  res.status(200).json(data);
}
