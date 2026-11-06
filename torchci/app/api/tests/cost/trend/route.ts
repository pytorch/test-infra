import { requireGithubWriteAccess } from "lib/api/auth";
import { costTrendHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costTrendHandler);
export const dynamic = "force-dynamic";
