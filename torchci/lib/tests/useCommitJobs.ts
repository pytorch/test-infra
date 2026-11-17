import type { CommitJobs } from "lib/api/tests/commit/jobs/types";
import type { CommitRunListPage } from "lib/api/tests/commit/types";
import type { JobDetail } from "lib/api/tests/job/types";
import {
  commitJobsApiUrl,
  fileTestsApiUrl,
  jobApiUrl,
} from "lib/tests/commitPage";
import { buildTimeline, Timeline } from "lib/tests/timeline";
import { useApiResource } from "lib/tests/useApiResource";
import { useEffect, useMemo, useState } from "react";

// What the commit page's timeline reads, each as the hooks read the API
// (useApiResource): fetched once per page load, shared through SWR's cache.

// The commit's jobs from GET /api/tests/commit/{sha}/jobs, as the timeline's
// tree. The endpoint's two fields are asked for apart, at once: the jobs
// answer in a fraction of the time their tests take, and the timeline is
// drawn from them, its tests pending, until the tests arrive. A job that has
// not ended runs until the moment the jobs arrived.
export function useCommitTimeline(
  repo: string | undefined,
  sha: string | undefined
): {
  // undefined until the jobs arrive, or after they fail.
  timeline: Timeline | undefined;
  // The jobs' failure, else the tests': with a timeline, the tests'.
  error: unknown;
  retry: () => void;
} {
  const known = repo !== undefined && sha !== undefined;
  const jobs = useApiResource<Required<Pick<CommitJobs, "jobs">>>(
    known ? commitJobsApiUrl(repo, sha, "jobs") : null
  );
  const tests = useApiResource<Required<Pick<CommitJobs, "tests">>>(
    known ? commitJobsApiUrl(repo, sha, "tests") : null
  );
  const [arrivedAt, setArrivedAt] = useState<number | null>(null);
  useEffect(() => {
    setArrivedAt(jobs.data === undefined ? null : Date.now() / 1000);
  }, [jobs.data]);
  const timeline = useMemo(
    () =>
      jobs.data === undefined || arrivedAt === null
        ? undefined
        : buildTimeline(jobs.data.jobs, tests.data?.tests, arrivedAt),
    [jobs.data, tests.data, arrivedAt]
  );
  return {
    timeline,
    error: jobs.error ?? tests.error,
    retry: () => {
      if (jobs.error !== undefined) void jobs.retry();
      if (tests.error !== undefined) void tests.retry();
    },
  };
}

// One job's steps and test files from GET /api/tests/job/{job_id}: asked
// for when the job is opened; nothing for null.
export function useJobDetail(jobId: string | null) {
  return useApiResource<JobDetail>(jobId === null ? null : jobApiUrl(jobId));
}

// The tests a file of a job names, from the commit's runs; nothing for null.
export function useFileTests(
  repo: string,
  sha: string,
  jobId: string | null,
  file: string | null
) {
  return useApiResource<CommitRunListPage>(
    jobId === null || file === null
      ? null
      : fileTestsApiUrl(repo, sha, jobId, file)
  );
}
