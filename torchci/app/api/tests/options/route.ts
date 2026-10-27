import { requireGithubWriteAccess } from "lib/api/auth";
import { testOptionsHandler } from "lib/api/tests/options/handler";

export const GET = requireGithubWriteAccess(testOptionsHandler);
export const dynamic = "force-dynamic";
