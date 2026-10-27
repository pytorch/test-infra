import { requireGithubWriteAccess } from "lib/api/auth";
import { commitRunsHandler } from "lib/api/tests/commit/handler";

export const GET = requireGithubWriteAccess(commitRunsHandler);
export const dynamic = "force-dynamic";
