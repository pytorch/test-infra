import { requireGithubWriteAccess } from "lib/api/auth";
import { costScopeHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costScopeHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
