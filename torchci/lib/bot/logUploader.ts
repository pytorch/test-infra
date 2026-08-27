import { invokeLogUploader } from "lib/lambda";
import { Context, Probot } from "probot";
import { isRepoEnabled, parseRepoAllowlist } from "./repoAllowlist";
import { isPyTorchbotSupportedOrg, isVLLM } from "./utils";

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

  // The allowlist exists so the cutover from the github-status-test webhook can
  // be done a repo at a time. While a repo still has that webhook, both paths
  // write the same S3 key -- harmless, but it doubles classifier calls, so the
  // allowlist is what bounds the overlap. Rolling back is editing this variable.
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
    // Never fail the webhook over a log. Rejecting marks the whole delivery
    // failed -- one delivery shared with every other workflow_job handler -- and
    // GitHub does not redeliver automatically, so throwing buys no retry either.
    // Dr.CI re-requests a missing log through backfillMissingLog on its next run.
    event.log.error(
      `Failed to queue a log upload for ${event.payload.repository.full_name} ` +
        `job ${event.payload.workflow_job.id}: ${error}`
    );
  }
}

export default function logUploader(app: Probot) {
  app.on("workflow_job", handleCompletedJob);
}
