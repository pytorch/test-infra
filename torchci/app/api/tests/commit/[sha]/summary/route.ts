import { requireGithubWriteAccess } from "lib/api/auth";
import { commitSummaryHandler } from "lib/api/tests/commit/summary/handler";

export const GET = requireGithubWriteAccess(commitSummaryHandler);
export const dynamic = "force-dynamic";
