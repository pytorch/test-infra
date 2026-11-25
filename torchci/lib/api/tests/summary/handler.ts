import { failQuery, rejectParameters, requestQuery } from "lib/api/handler";
import { parseTestSummaryParams } from "lib/api/tests/summary/parameters";
import { summarizeTests } from "lib/api/tests/summary/summary";

// Neither a list nor a detail: one object for a repository, with no cursor
// and no 404, since a repository without tests has figures too, all zero.
export async function testSummaryHandler(request: Request): Promise<Response> {
  const parsed = parseTestSummaryParams(await requestQuery(request));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    return Response.json(await summarizeTests(parsed.data));
  } catch (error) {
    return failQuery(
      "GET /api/tests/summary",
      "Failed to summarize the tests",
      error
    );
  }
}
