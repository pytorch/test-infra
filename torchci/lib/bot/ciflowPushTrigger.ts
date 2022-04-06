import { Context, Probot } from "probot";

function isCIFlowLabel(label: string): boolean {
  return label.startsWith("ciflow/") || label.startsWith("ci/");
}

function labelToTag(label: string, prNum: number): string {
  return `${label}/${prNum}`;
}

function getAllPRTags(
  context: Context<"pull_request"> | Context<"pull_request.closed">
) {
  const prNum = context.payload.pull_request.number;
  const labels = context.payload.pull_request.labels
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
async function syncTag(
  context: Context<"pull_request"> | Context<"pull_request.labeled">,
  tag: string,
  headSha: string
) {
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
async function rmTag(
  context: Context<"pull_request.closed"> | Context<"pull_request.unlabeled">,
  tag: string
) {
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
async function handleSyncEvent(context: Context<"pull_request">) {
  context.log.debug("START Processing sync event");

  const headSha = context.payload.pull_request.head.sha;
  const tags = getAllPRTags(context);
  const promises = tags.map(
    async (tag) => await syncTag(context, tag, headSha)
  );
  await Promise.all(promises);
  context.log.info("END Processing sync event");
}

// Remove the tag corresponding to the removed label.
async function handleUnlabeledEvent(
  context: Context<"pull_request.unlabeled">
) {
  context.log.debug("START Processing unlabeled event");

  const label = context.payload.label.name;
  if (!isCIFlowLabel(label)) {
    return;
  }
  const prNum = context.payload.pull_request.number;
  const tag = labelToTag(context.payload.label.name, prNum);
  await rmTag(context, tag);
}

// Remove all tags as this PR is closed.
async function handleClosedEvent(context: Context<"pull_request.closed">) {
  context.log.debug("START Processing rm event");

  const tags = getAllPRTags(context);
  const promises = tags.map(async (tag) => await rmTag(context, tag));
  await Promise.all(promises);
}

// Add the tag corresponding to the new label.
async function handleLabelEvent(context: Context<"pull_request.labeled">) {
  context.log.debug("START Processing label event");
  if (context.payload.pull_request.state === "closed") {
    // Ignore closed PRs. If this PR is reopened, the tags will get pushed as
    // part of the sync event handling.
    return;
  }

  const label = context.payload.label.name;
  if (!isCIFlowLabel(label)) {
    return;
  }

  // collected from .github/workflows/*
  const valid_labels = ["ciflow/trunk", "ciflow/periodic", "ciflow/all", "ciflow/android", "ciflow/binaries",
    "ciflow/binaries_conda", "ciflow/binaries_libtorch", "ciflow/binaries_wheel"];
  if (!valid_labels.includes(label)) {
    let body = `We have recently simplified the CIFlow labels and \`${label}\` is no longer in use.\n`;
    body += "You can use any of the following\n";
    body += "- `ciflow/trunk` (`.github/workflows/trunk.yml`): all jobs we run per-commit on master\n";
    body += "- `ciflow/periodic` (`.github/workflows/periodic.yml`): all jobs we run periodically on master\n";
    body += "- `ciflow/all`: trunk + periodic; all jobs we run in master CI\n";
    body += "- `ciflow/android` (`.github/workflows/run_android_tests.yml`): android build and test\n";
    body += "- `ciflow/binaries`: all binary build and upload jobs\n";
    body += " - `ciflow/binaries_conda`: binary build and upload job for conda\n";
    body += " - `ciflow/binaries_libtorch`: binary build and upload job for libtorch\n";
    body += " - `ciflow/binaries_wheel`: binary build and upload job for wheel";
    await context.octokit.issues.createComment(
      context.repo({
        body,
        issue_number: context.payload.pull_request.number,
      })
    );
    return;
  }
  const prNum = context.payload.pull_request.number;
  const tag = labelToTag(context.payload.label.name, prNum);
  await syncTag(context, tag, context.payload.pull_request.head.sha);
}

export default function ciflowPushTrigger(app: Probot) {
  app.on("pull_request.labeled", handleLabelEvent);
  app.on(
    [
      "pull_request.synchronize",
      "pull_request.opened",
      "pull_request.reopened",
    ],
    handleSyncEvent
  );
  app.on("pull_request.closed", handleClosedEvent);
  app.on("pull_request.unlabeled", handleUnlabeledEvent);
}
