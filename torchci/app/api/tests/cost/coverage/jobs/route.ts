import { requireGithubWriteAccess } from "lib/api/auth";
import { costCoverageJobsHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costCoverageJobsHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
