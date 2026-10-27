import { requireGithubWriteAccess } from "lib/api/auth";
import { runHandler } from "lib/api/tests/run/handler";

export const GET = requireGithubWriteAccess(runHandler);
export const dynamic = "force-dynamic";
