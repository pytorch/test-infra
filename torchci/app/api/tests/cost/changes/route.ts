import { requireGithubWriteAccess } from "lib/api/auth";
import { costChangesHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costChangesHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
