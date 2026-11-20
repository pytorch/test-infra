import { handleDetail, requestQuery } from "lib/api/handler";
import { getCommitGreenlight } from "lib/api/tests/commit/greenlight/greenlight";
import { parseCommitParams } from "lib/api/tests/commit/parameters";

// The verdict takes the commit alone, the repository and the full SHA.
export async function commitGreenlightHandler(
  request: Request,
  { params }: { params: Promise<{ sha: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/commit/{sha}/greenlight",
    failure: "Failed to read the commit's GreenLight verdict",
    // Never answered: a commit without a verdict has a null one.
    notFound: "Commit not found",
    parse: parseCommitParams,
    get: getCommitGreenlight,
  });
}
