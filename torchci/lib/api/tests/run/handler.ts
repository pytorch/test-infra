import { handleDetail, requestQuery } from "lib/api/handler";
import { getRun } from "lib/api/tests/run/detail";
import { parseRunDetailParams } from "lib/api/tests/run/parameters";

export async function runHandler(
  request: Request,
  { params }: { params: Promise<{ run_id: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/run/{run_id}",
    failure: "Failed to get run",
    notFound: "Run not found",
    parse: parseRunDetailParams,
    get: ({ run_id }) => getRun(run_id),
  });
}
