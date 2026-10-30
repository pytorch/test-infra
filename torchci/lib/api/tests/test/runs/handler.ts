import {
  failQuery,
  handleList,
  rejectParameters,
  requestQuery,
} from "lib/api/handler";
import type { RawQuery } from "lib/api/parameters";
import {
  decodeRunsCursor,
  runsCursorMatchesQuery,
} from "lib/api/tests/test/runs/cursor";
import { queryRunGrid } from "lib/api/tests/test/runs/grid";
import { listRuns } from "lib/api/tests/test/runs/list";
import {
  parseRunsGridParams,
  parseRunsListParams,
} from "lib/api/tests/test/runs/parameters";

const ROUTE = "GET /api/tests/test/{test_id}/runs";

// The runs grouped by commit: one read, no pages, so none of the list flow's
// cursor handling; an unknown test or a selection matching no run is an
// empty grid, not a 404, as an empty page is for the list.
async function handleGrid(rawQuery: RawQuery): Promise<Response> {
  const parsed = parseRunsGridParams(rawQuery);
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    return Response.json(await queryRunGrid(parsed.data));
  } catch (error) {
    return failQuery(ROUTE, "Failed to group test runs by commit", error);
  }
}

export async function runsHandler(
  request: Request,
  { params }: { params: Promise<{ test_id: string }> }
): Promise<Response> {
  const rawQuery = await requestQuery(request, params);
  if (rawQuery.group_by !== undefined) return handleGrid(rawQuery);
  return handleList(request, rawQuery, {
    route: ROUTE,
    failure: "Failed to list test runs",
    parse: parseRunsListParams,
    decodeCursor: decodeRunsCursor,
    cursorMatchesQuery: runsCursorMatchesQuery,
    list: listRuns,
  });
}
