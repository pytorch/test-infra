import { requireGithubWriteAccess } from "lib/api/auth";
import { costHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
