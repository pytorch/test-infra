import { handleDetail, requestQuery } from "lib/api/handler";
import { parseCommitSummaryParams } from "lib/api/tests/commit/summary/parameters";
import { getCommitSummary } from "lib/api/tests/commit/summary/summary";

export async function commitSummaryHandler(
  request: Request,
  { params }: { params: Promise<{ sha: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/commit/{sha}/summary",
    failure: "Failed to summarize the commit's tests",
    notFound: "Commit not found",
    parse: parseCommitSummaryParams,
    get: getCommitSummary,
  });
}
