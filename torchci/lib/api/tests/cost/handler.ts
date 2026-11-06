import { failQuery, rejectParameters, requestQuery } from "lib/api/handler";
import { getCostChanges } from "lib/api/tests/cost/changes";
import {
  parseCostChangesParams,
  parseCostParams,
  parseCostTrendParams,
} from "lib/api/tests/cost/parameters";
import { getRunnerHours } from "lib/api/tests/cost/runnerHours";
import { getCostTrend } from "lib/api/tests/cost/trend";

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

// The trend, cached as the runner-hours are: its last period ends at the
// start of today.
export async function costTrendHandler(request: Request): Promise<Response> {
  const parsed = parseCostTrendParams(await requestQuery(request));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    return Response.json(await getCostTrend(parsed.data), {
      headers: {
        "Cache-Control": "private, max-age=600",
        Vary: "Authorization, Cookie",
      },
    });
  } catch (error) {
    return failQuery(
      "GET /api/tests/cost/trend",
      "Failed to compute the runner-hours trend",
      error
    );
  }
}

// What changed between two periods, cached as the trend is: the periods end
// by yesterday, and a day's rollup changes at most every few hours.
export async function costChangesHandler(request: Request): Promise<Response> {
  const parsed = parseCostChangesParams(await requestQuery(request));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    return Response.json(await getCostChanges(parsed.data), {
      headers: {
        "Cache-Control": "private, max-age=600",
        Vary: "Authorization, Cookie",
      },
    });
  } catch (error) {
    return failQuery(
      "GET /api/tests/cost/changes",
      "Failed to compare the runner-hours",
      error
    );
  }
}
