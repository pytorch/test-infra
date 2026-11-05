import { handleDetail, requestQuery } from "lib/api/handler";
import { getPullRequestHead } from "lib/api/tests/pull/head";
import { parsePullRequestParams } from "lib/api/tests/pull/parameters";

export async function pullRequestHandler(
  request: Request,
  { params }: { params: Promise<{ number: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/pull/{number}",
    failure: "Failed to find the pull request's head",
    notFound: "Pull request not found",
    parse: parsePullRequestParams,
    get: getPullRequestHead,
  });
}
