import { requireGithubWriteAccess } from "lib/api/auth";
import { testHandler } from "lib/api/tests/test/handler";

export const GET = requireGithubWriteAccess(testHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
