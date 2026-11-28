import { requireGithubWriteAccess } from "lib/api/auth";
import { costOwnersHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costOwnersHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
