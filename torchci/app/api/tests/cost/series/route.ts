import { requireGithubWriteAccess } from "lib/api/auth";
import { costSeriesHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costSeriesHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
