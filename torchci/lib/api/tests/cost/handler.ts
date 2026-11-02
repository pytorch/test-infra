import { failQuery, rejectParameters, requestQuery } from "lib/api/handler";
import { parseCostParams } from "lib/api/tests/cost/parameters";
import { getRunnerHours } from "lib/api/tests/cost/runnerHours";

// One bounded answer, a few thousand cells, so it has no cursor. The window
// ends at the start of today; the browser may keep the answer ten minutes.
// Private, since the route is behind the GitHub gate.
export async function costHandler(request: Request): Promise<Response> {
  const parsed = parseCostParams(await requestQuery(request));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    return Response.json(await getRunnerHours(parsed.data), {
      headers: {
        "Cache-Control": "private, max-age=600",
        Vary: "Authorization, Cookie",
      },
    });
  } catch (error) {
    return failQuery(
      "GET /api/tests/cost",
      "Failed to compute the runner-hours",
      error
    );
  }
}
