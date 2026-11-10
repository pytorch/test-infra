import { requireGithubWriteAccess } from "lib/api/auth";
import { testOptionsHandler } from "lib/api/tests/options/handler";

export const GET = requireGithubWriteAccess(testOptionsHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
