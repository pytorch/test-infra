import { handleList, requestQuery } from "lib/api/handler";
import {
  commitRunsCursorMatchesQuery,
  decodeCommitRunsCursor,
} from "lib/api/tests/commit/cursor";
import { listCommitRuns } from "lib/api/tests/commit/list";
import { parseCommitRunsListParams } from "lib/api/tests/commit/parameters";

export async function commitRunsHandler(
  request: Request,
  { params }: { params: Promise<{ sha: string }> }
): Promise<Response> {
  return handleList(request, await requestQuery(request, params), {
    route: "GET /api/tests/commit/{sha}",
    failure: "Failed to list commit test runs",
    parse: parseCommitRunsListParams,
    decodeCursor: decodeCommitRunsCursor,
    cursorMatchesQuery: commitRunsCursorMatchesQuery,
    list: listCommitRuns,
  });
}
