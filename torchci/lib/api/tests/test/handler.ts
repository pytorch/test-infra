import {
  failQuery,
  jsonError,
  rejectParameters,
  requestQuery,
} from "lib/api/handler";
import { getTest } from "lib/api/tests/test/detail";
import { parseTestDetailParams } from "lib/api/tests/test/parameters";

export async function testHandler(
  request: Request,
  { params }: { params: Promise<{ test_id: string }> }
): Promise<Response> {
  const parsed = parseTestDetailParams(await requestQuery(request, params));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    const test = await getTest(parsed.data.test_id);
    if (test === null) return jsonError(404, "Test not found");
    return Response.json(test);
  } catch (error) {
    return failQuery(
      "GET /api/tests/test/{test_id}",
      "Failed to get test",
      error
    );
  }
}
