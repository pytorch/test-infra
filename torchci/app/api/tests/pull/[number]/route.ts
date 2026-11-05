import { requireGithubWriteAccess } from "lib/api/auth";
import { pullRequestHandler } from "lib/api/tests/pull/handler";

export const GET = requireGithubWriteAccess(pullRequestHandler);
export const dynamic = "force-dynamic";
