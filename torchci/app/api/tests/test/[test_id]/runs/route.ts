import { requireGithubWriteAccess } from "lib/api/auth";
import { runsHandler } from "lib/api/tests/test/runs/handler";

export const GET = requireGithubWriteAccess(runsHandler);
export const dynamic = "force-dynamic";
