import { failQuery, rejectParameters, requestQuery } from "lib/api/handler";
import { testOptions } from "lib/api/tests/options/options";
import { parseTestOptionsParams } from "lib/api/tests/options/parameters";

// Answers from the parameter definitions and the two small catalogs, whose
// distinct values are read on each request. The answer changes with a deploy
// or a newly recorded environment or env var set, both rare, so the caller's
// browser may keep it briefly, as it may the OpenAPI document. Private, since
// the route is behind the GitHub gate: a shared cache must not hand one
// caller's answer to the next, and the answer varies with the credential.
export async function testOptionsHandler(request: Request): Promise<Response> {
  const parsed = parseTestOptionsParams(await requestQuery(request));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    return Response.json(await testOptions(), {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=3600",
        Vary: "Authorization, Cookie",
      },
    });
  } catch (error) {
    return failQuery(
      "GET /api/tests/options",
      "Could not read the catalogs the options come from",
      error
    );
  }
}
