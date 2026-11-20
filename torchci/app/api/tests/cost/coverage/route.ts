import { requireGithubWriteAccess } from "lib/api/auth";
import { costCoverageHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costCoverageHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
