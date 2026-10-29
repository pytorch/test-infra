import { handleDetail, requestQuery } from "lib/api/handler";
import { getTest } from "lib/api/tests/test/detail";
import { parseTestDetailParams } from "lib/api/tests/test/parameters";

export async function testHandler(
  request: Request,
  { params }: { params: Promise<{ test_id: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/test/{test_id}",
    failure: "Failed to get test",
    notFound: "Test not found",
    parse: parseTestDetailParams,
    get: ({ test_id }) => getTest(test_id),
  });
}
