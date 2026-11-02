import { requireGithubWriteAccess } from "lib/api/auth";
import { costHandler } from "lib/api/tests/cost/handler";

export const GET = requireGithubWriteAccess(costHandler);
export const dynamic = "force-dynamic";
