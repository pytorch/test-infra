import { requireGithubWriteAccess } from "lib/api/auth";
import { commitGreenlightHandler } from "lib/api/tests/commit/greenlight/handler";

export const GET = requireGithubWriteAccess(commitGreenlightHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
