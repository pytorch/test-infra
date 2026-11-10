import { requireGithubWriteAccess } from "lib/api/auth";
import { runHandler } from "lib/api/tests/run/handler";

// No HUD page reads a run, and each lookup scans every retained run (the
// operation's description), so this route does not admit the pages'
// requests: every caller needs a credential.
export const GET = requireGithubWriteAccess(runHandler);
export const dynamic = "force-dynamic";
