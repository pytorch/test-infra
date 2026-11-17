import { handleDetail, requestQuery } from "lib/api/handler";
import { getJobDetail } from "lib/api/tests/job/detail";
import { parseJobDetailParams } from "lib/api/tests/job/parameters";

export async function jobHandler(
  request: Request,
  { params }: { params: Promise<{ job_id: string }> }
): Promise<Response> {
  return handleDetail(await requestQuery(request, params), {
    route: "GET /api/tests/job/{job_id}",
    failure: "Failed to read the job",
    notFound: "Job not found",
    parse: parseJobDetailParams,
    get: getJobDetail,
  });
}
