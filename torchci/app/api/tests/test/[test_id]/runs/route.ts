import { requireGithubWriteAccess } from "lib/api/auth";
import { runsHandler } from "lib/api/tests/test/runs/handler";

export const GET = requireGithubWriteAccess(runsHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
