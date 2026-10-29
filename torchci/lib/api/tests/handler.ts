import { handleList, requestQuery } from "lib/api/handler";
import { cursorMatchesQuery, decodeCursor } from "lib/api/tests/cursor";
import { listTests } from "lib/api/tests/list";
import { parseTestListParams } from "lib/api/tests/parameters";

export async function testsHandler(request: Request): Promise<Response> {
  return handleList(request, await requestQuery(request), {
    route: "GET /api/tests",
    failure: "Failed to list tests",
    parse: parseTestListParams,
    decodeCursor,
    cursorMatchesQuery,
    list: listTests,
  });
}
