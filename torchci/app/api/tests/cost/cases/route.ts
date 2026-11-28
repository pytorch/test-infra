import { requireGithubWriteAccess } from "lib/api/auth";
import { costCasesHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costCasesHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
