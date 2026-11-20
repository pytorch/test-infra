import { handleDetail, requestQuery } from "lib/api/handler";
import { getCommitJobs } from "lib/api/tests/commit/jobs/jobs";
import { parseCommitJobsParams } from "lib/api/tests/commit/jobs/parameters";

// A commit HUD does not know has no jobs.
export async function commitJobsHandler(
  request: Request,
  { params }: { params: Promise<{ sha: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/commit/{sha}/jobs",
    failure: "Failed to read the commit's jobs",
    notFound: "Commit not found",
    parse: parseCommitJobsParams,
    get: getCommitJobs,
  });
}
