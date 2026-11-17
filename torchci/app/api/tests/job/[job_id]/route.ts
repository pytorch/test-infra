import { requireGithubWriteAccess } from "lib/api/auth";
import { jobHandler } from "lib/api/tests/job/handler";

export const GET = requireGithubWriteAccess(jobHandler, {
  admitHudPages: true,
});
export const dynamic = "force-dynamic";
