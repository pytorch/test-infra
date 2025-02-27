import { Context, Probot } from "probot";
import { canRunWorkflows } from "./autoLabelBot";
import {
  CachedConfigTracker,
  hasApprovedPullRuns,
  hasWritePermissions,
  isPyTorchPyTorch,
} from "./utils";

function isCIFlowLabel(label: string): boolean {
  return label.startsWith("ciflow/") || label.startsWith("ci/");
}

function labelToTag(label: string, prNum: number): string {
  return `${label}/${prNum}`;
}

function getAllPRTags(
  context: Context,
  payload: Context<"pull_request" | "pull_request.closed">["payload"]
) {
  const prNum = payload.pull_request.number;
  const labels = payload.pull_request.labels
    .map((label) => label.name)
    .filter(isCIFlowLabel);

  context.log.info(labels, "Found labels on PR");
  return labels.map((label) => labelToTag(label, prNum));
}

/**
 * Make sure `tag` points to `head_sha`, deleting old tags as necessary.
 * @param tag  looks like "ciflow/trunk/12345", where 12345 is the PR number.
 * @param headSha
 */
async function syncTag(context: Context, tag: string, headSha: string) {
  context.log.info(`Synchronizing tag ${tag} to head sha ${headSha}`);
  const matchingTags = await context.octokit.git.listMatchingRefs(
    context.repo({ ref: `tags/${tag}` })
  );
  if (matchingTags.data.length > 0) {
    context.log.info(matchingTags.data, "Found matching tags");
  } else {
    context.log.info(`No matching tags`);
  }
  for (const match of matchingTags.data) {
    if (match.object.sha === headSha) {
      context.log.info(`Tag ${tag} already points to ${headSha}`);
      return;
    }

    context.log.info(
      `deleting out of date tag ${tag} on sha ${match.object.sha}`
    );
    await context.octokit.git.deleteRef(context.repo({ ref: `tags/${tag}` }));
  }

  context.log.info(`Creating tag ${tag} on head sha ${headSha}`);
  await context.octokit.git.createRef(
    context.repo({ ref: `refs/tags/${tag}`, sha: headSha })
  );
}

/**
 * Remove a tag from the repo if necessary.
 * @param tag  looks like "ciflow/trunk/12345", where 12345 is the PR number.
 */
async function rmTag(context: Context, tag: string) {
  context.log.info(`Cleaning up tag ${tag}`);
  const matchingTags = await context.octokit.git.listMatchingRefs(
    context.repo({ ref: `tags/${tag}` })
  );
  for (const match of matchingTags.data) {
    if (match.ref === `refs/tags/${tag}`) {
      context.log.info(`Deleting tag ${tag} on sha ${match.object.sha}`);
      await context.octokit.git.deleteRef(context.repo({ ref: `tags/${tag}` }));
      return;
    }
  }
  context.log.info(`No matching tags for ${tag}`);
}

/**
 * We check all the CIFlow labels on the PR and make sure the corresponding tags
 * are pointing to the PR's head SHA.
 */
async function handleSyncEvent(
  context: Context,
  payload: Context<"pull_request">["payload"]
) {
  context.log.debug("START Processing sync event");

  if (!(await canRunWorkflows(context as any))) {
    context.log.info("PR does not have permissions to run workflows");
    for (const label of payload.pull_request.labels) {
      if (isCIFlowLabel(label.name)) {
        await context.octokit.issues.removeLabel(
          context.repo({
            issue_number: payload.pull_request.number,
            name: label.name,
          })
        );
      }
    }
    return;
  }

  const headSha = payload.pull_request.head.sha;
  const tags = getAllPRTags(context, payload);
  const promises = tags.map(
    async (tag) => await syncTag(context, tag, headSha)
  );
  await Promise.all(promises);
  context.log.info("END Processing sync event");
}

// Remove the tag corresponding to the removed label.
async function handleUnlabeledEvent(
  context: Context,
  payload: Context<"pull_request.unlabeled">["payload"]
) {
  context.log.debug("START Processing unlabeled event");

  const label = payload.label.name;
  if (!isCIFlowLabel(label)) {
    return;
  }
  const prNum = payload.pull_request.number;
  const tag = labelToTag(payload.label.name, prNum);
  await rmTag(context, tag);
}

// Remove all tags as this PR is closed.
async function handleClosedEvent(
  context: Context,
  payload: Context<"pull_request.closed">["payload"]
) {
  context.log.debug("START Processing rm event");

  const tags = getAllPRTags(context, payload);
  const promises = tags.map(async (tag) => await rmTag(context, tag));
  await Promise.all(promises);
}

// Add the tag corresponding to the new label.
async function handleLabelEvent(
  context: Context,
  payload: Context<"pull_request.labeled">["payload"],
  tracker: CachedConfigTracker
) {
  context.log.debug("START Processing label event");
  if (payload.pull_request.state === "closed") {
    // Ignore closed PRs. If this PR is reopened, the tags will get pushed as
    // part of the sync event handling.
    return;
  }

  const label = payload.label.name;
  if (!isCIFlowLabel(label)) {
    return;
  }
  const config: any = await tracker.loadConfig(context);
  const valid_labels: Array<string> =
    config !== null ? config["ciflow_push_tags"] : null;
  if (valid_labels == null) {
    await context.octokit.issues.createComment(
      context.repo({
        body:
          "No ciflow labels are configured for this repo.\n" +
          "For information on how to enable CIFlow bot see " +
          "this [wiki]( https://github.com/pytorch/test-infra/wiki/PyTorch-bot#ciflow-bot)",
        issue_number: payload.pull_request.number,
      })
    );
    return;
  }
  const prNum = payload.pull_request.number;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const has_write_permissions = await hasWritePermissions(
    context,
    payload.pull_request.user.login
  );
  const has_ci_approved = has_write_permissions
    ? true
    : await hasApprovedPullRuns(
        context.octokit,
        owner,
        repo,
        payload.pull_request.head.sha
      );
  if (!valid_labels.includes(label)) {
    let body = `Unknown label \`${label}\`.\n Currently recognized labels are\n`;
    valid_labels.forEach((l: string) => {
      body += ` - \`${l}\`\n`;
    });
    if (has_ci_approved) {
      body =
        "Warning: " +
        body +
        "\n Please add the new label to .github/pytorch-probot.yml";
    }
    await context.octokit.issues.createComment(
      context.repo({
        body,
        issue_number: prNum,
      })
    );
    if (!has_ci_approved) {
      return;
    }
  }
  if (!has_ci_approved) {
    let body =
      "To add the ciflow label `" +
      label +
      "` please first approve the workflows " +
      "that are awaiting approval (scroll to the bottom of this page).\n\n" +
      "This helps ensure we don't trigger CI on this PR until it is actually authorized to do so. " +
      "Please ping one of the reviewers if you do not have access to approve and run workflows.";
    await context.octokit.issues.createComment(
      context.repo({
        body,
        issue_number: prNum,
      })
    );
    await context.octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: prNum,
      name: label,
    });
    return;
  }

  // https://github.com/pytorch/pytorch/pull/26921 is a special PR that should
  // never get ciflow tags
  if (prNum == 26921 && isPyTorchPyTorch(owner, repo)) {
    return;
  }
  const tag = labelToTag(payload.label.name, prNum);
  await syncTag(context, tag, payload.pull_request.head.sha);
}

export default function ciflowPushTrigger(app: Probot) {
  const tracker = new CachedConfigTracker(app);
  app.on("pull_request.labeled", async (context) => {
    await handleLabelEvent(context, context.payload, tracker);
  });
  app.on(
    [
      "pull_request.synchronize",
      "pull_request.opened",
      "pull_request.reopened",
    ],
    async (context) => {
      await handleSyncEvent(context, context.payload);
    }
  );
  app.on("pull_request.closed", async (context) => {
    await handleClosedEvent(context, context.payload);
  });
  app.on("pull_request.unlabeled", async (context) => {
    await handleUnlabeledEvent(context, context.payload);
  });
}
