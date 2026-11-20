import { requireGithubWriteAccess } from "lib/api/auth";
import { testsHandler } from "lib/api/tests/handler";

export const GET = requireGithubWriteAccess(testsHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
