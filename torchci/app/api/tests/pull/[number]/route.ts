import { requireGithubWriteAccess } from "lib/api/auth";
import { pullRequestHandler } from "lib/api/tests/pull/handler";

export const GET = requireGithubWriteAccess(pullRequestHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
