import { requireGithubWriteAccess } from "lib/api/auth";
import { commitSummaryHandler } from "lib/api/tests/commit/summary/handler";

export const GET = requireGithubWriteAccess(commitSummaryHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
