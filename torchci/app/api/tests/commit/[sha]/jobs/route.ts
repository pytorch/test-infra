import { requireGithubWriteAccess } from "lib/api/auth";
import { commitJobsHandler } from "lib/api/tests/commit/jobs/handler";

export const GET = requireGithubWriteAccess(commitJobsHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
