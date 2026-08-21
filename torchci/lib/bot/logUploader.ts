import { invokeLogUploader } from "lib/lambda";
import { Context, Probot } from "probot";
import { isPyTorchbotSupportedOrg, isVLLM } from "./utils";

/**
 * Comma-separated list of repos whose logs this handler uploads. Entries are
 * either `owner/repo` or `owner/*`; an empty or unset value disables the
 * handler entirely.
 *
 * This exists so the cutover from the github-status-test webhook can be done a
 * repo at a time. While a repo still has that webhook, both paths write the same
 * S3 key -- harmless, but it doubles classifier calls, so the allowlist is what
 * bounds the overlap. Rolling back is editing this variable.
 */
export function parseRepoAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  );
}

export function isRepoEnabled(
  allowlist: Set<string>,
  owner: string,
  repo: string
): boolean {
  return (
    allowlist.has(`${owner}/${repo}`.toLowerCase()) ||
    allowlist.has(`${owner.toLowerCase()}/*`)
  );
}

async function handleCompletedJob(event: Context<"workflow_job">) {
  if (event.payload.action !== "completed") {
    return;
  }

  const owner = event.payload.repository.owner.login;
  const repo = event.payload.repository.name;
  if (!isPyTorchbotSupportedOrg(owner) && !isVLLM(owner)) {
    event.log(`${__filename} isn't enabled on ${owner}'s repos`);
    return;
  }

  const allowlist = parseRepoAllowlist(process.env.LOG_UPLOADER_REPOS);
  if (!isRepoEnabled(allowlist, owner, repo)) {
    return;
  }

  try {
    await invokeLogUploader({
      repo: event.payload.repository.full_name,
      job_id: event.payload.workflow_job.id,
      conclusion: event.payload.workflow_job.conclusion,
    });
  } catch (error) {
    // Never fail the webhook over a log. GitHub would redeliver the whole event,
    // re-running every other handler, to retry something Dr.CI already repairs
    // on its own via backfillMissingLog.
    event.log.error(
      `Failed to queue a log upload for ${event.payload.repository.full_name} ` +
        `job ${event.payload.workflow_job.id}: ${error}`
    );
  }
}

export default function logUploader(app: Probot) {
  app.on("workflow_job", handleCompletedJob);
}
