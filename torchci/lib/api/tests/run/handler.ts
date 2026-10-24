import {
  failQuery,
  jsonError,
  rejectParameters,
  requestQuery,
} from "lib/api/handler";
import { getRun } from "lib/api/tests/run/detail";
import { parseRunDetailParams } from "lib/api/tests/run/parameters";

export async function runHandler(
  request: Request,
  { params }: { params: Promise<{ run_id: string }> }
): Promise<Response> {
  const parsed = parseRunDetailParams(await requestQuery(request, params));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    const run = await getRun(parsed.data.run_id);
    if (run === null) return jsonError(404, "Run not found");
    return Response.json(run);
  } catch (error) {
    return failQuery("GET /api/tests/run/{run_id}", "Failed to get run", error);
  }
}
