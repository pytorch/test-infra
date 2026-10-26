import { failQuery, rejectParameters, requestQuery } from "lib/api/handler";
import { testOptions } from "lib/api/tests/options/options";
import { parseTestOptionsParams } from "lib/api/tests/options/parameters";

// Answers from the parameter definitions and the two small catalogs, whose
// distinct values are read on each request. The answer changes with a deploy
// or a newly recorded environment or env var set, both rare, so clients may
// cache it briefly, as they may the OpenAPI document.
export async function testOptionsHandler(request: Request): Promise<Response> {
  const parsed = parseTestOptionsParams(await requestQuery(request));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    return Response.json(await testOptions(), {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
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
