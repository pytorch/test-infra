import { failQuery, rejectParameters, requestQuery } from "lib/api/handler";
import type { RawQuery } from "lib/api/parameters";
import { getCostCases } from "lib/api/tests/cost/cases";
import {
  getCostCoverage,
  getCostCoverageJobs,
} from "lib/api/tests/cost/coverage";
import {
  parseCostCasesParams,
  parseCostCoverageJobsParams,
  parseCostCoverageParams,
  parseCostParams,
  parseCostScopeParams,
  parseCostSeriesParams,
  parseCostTrendParams,
} from "lib/api/tests/cost/parameters";
import { getRunnerHours } from "lib/api/tests/cost/runnerHours";
import { getCostScope } from "lib/api/tests/cost/scope";
import { getCostSeries } from "lib/api/tests/cost/series";
import { getCostTrend } from "lib/api/tests/cost/trend";
import type { z } from "zod/v4";

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

// A drill or banner endpoint: parse, answer, cache privately for maxAge
// seconds (the days asked are past days, recomputed at most every few
// hours), or say what failed without its details.
function cachedCostHandler<P>(
  path: string,
  failure: string,
  parse: (
    _raw: RawQuery
  ) => { success: true; data: P } | { success: false; error: z.ZodError },
  answer: (_params: P) => Promise<unknown>,
  maxAge: number
): (_request: Request) => Promise<Response> {
  return async (request) => {
    const parsed = parse(await requestQuery(request));
    if (!parsed.success) return rejectParameters(parsed.error);
    try {
      return Response.json(await answer(parsed.data), {
        headers: {
          "Cache-Control": `private, max-age=${maxAge}`,
          Vary: "Authorization, Cookie",
        },
      });
    } catch (error) {
      return failQuery(`GET ${path}`, failure, error);
    }
  };
}

// A drill scope's children in A and B.
export const costScopeHandler = cachedCostHandler(
  "/api/tests/cost/scope",
  "Failed to compute the scope's runner-hours",
  parseCostScopeParams,
  getCostScope,
  600
);

// A drill scope's runner-hours by day: the bars below the owner root.
export const costSeriesHandler = cachedCostHandler(
  "/api/tests/cost/series",
  "Failed to compute the scope's runner-hours by day",
  parseCostSeriesParams,
  getCostSeries,
  600
);

// A file's configurations and cases from the runs table: a heavy scan
// behind a gate, kept an hour.
export const costCasesHandler = cachedCostHandler(
  "/api/tests/cost/cases",
  "Failed to read the file's test cases",
  parseCostCasesParams,
  getCostCases,
  3600
);

// The coverage banner's test-job segments.
export const costCoverageHandler = cachedCostHandler(
  "/api/tests/cost/coverage",
  "Failed to compute the test-job coverage",
  parseCostCoverageParams,
  getCostCoverage,
  600
);

// The coverage banner's organization and repository jobs: a heavy scan of
// the jobs table, kept an hour.
export const costCoverageJobsHandler = cachedCostHandler(
  "/api/tests/cost/coverage/jobs",
  "Failed to compute the organization's job hours",
  parseCostCoverageJobsParams,
  getCostCoverageJobs,
  3600
);
