import { handleList, requestQuery } from "lib/api/handler";
import {
  decodeRunsCursor,
  runsCursorMatchesQuery,
} from "lib/api/tests/test/runs/cursor";
import { listRuns } from "lib/api/tests/test/runs/list";
import { parseRunsListParams } from "lib/api/tests/test/runs/parameters";

export async function runsHandler(
  request: Request,
  { params }: { params: Promise<{ test_id: string }> }
): Promise<Response> {
  return handleList(await requestQuery(request, params), {
    route: "GET /api/tests/test/{test_id}/runs",
    failure: "Failed to list test runs",
    parse: parseRunsListParams,
    decodeCursor: decodeRunsCursor,
    cursorMatchesQuery: runsCursorMatchesQuery,
    list: listRuns,
  });
}
