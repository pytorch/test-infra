import { requireGithubWriteAccess } from "lib/api/auth";
import { costTrendHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costTrendHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
