import { requireGithubWriteAccess } from "lib/api/auth";
import { testSummaryHandler } from "lib/api/tests/summary/handler";

export const GET = requireGithubWriteAccess(testSummaryHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
