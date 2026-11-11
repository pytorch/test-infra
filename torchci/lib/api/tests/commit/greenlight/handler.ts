import { handleDetail, requestQuery } from "lib/api/handler";
import { getCommitGreenlight } from "lib/api/tests/commit/greenlight/greenlight";
import { parseCommitSummaryParams } from "lib/api/tests/commit/summary/parameters";

// The verdict takes the commit as the summary does, the repository and the
// full SHA, so it is read with the summary's parameters.
export async function commitGreenlightHandler(
  request: Request,
  { params }: { params: Promise<{ sha: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/commit/{sha}/greenlight",
    failure: "Failed to read the commit's GreenLight verdict",
    // Never answered: a commit without a verdict has a null one.
    notFound: "Commit not found",
    parse: parseCommitSummaryParams,
    get: getCommitGreenlight,
  });
}
