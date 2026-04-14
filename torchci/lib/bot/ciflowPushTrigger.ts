import { Context, Probot } from "probot";
import { canRunWorkflows } from "./autoLabelBot";
import {
  CachedConfigTracker,
  hasApprovedPullRuns,
  hasWritePermissions,
  isPyTorchbotSupportedOrg,
  isPyTorchPyTorch,
} from "./utils";

const CIFLOW_PENDING_MARKER = "<!-- ciflow-pending -->";

function isCIFlowLabel(label: string): boolean {
  return label.startsWith("ciflow/");
}

/**
 * Find an existing pending ciflow comment on the PR (identified by the marker).
 */
async function findPendingCiflowComment(context: Context, prNum: number) {
  const comments = await context.octokit.issues.listComments(
    context.repo({ issue_number: prNum, per_page: 100 })
  );
  return comments.data.find((c) => c.body?.includes(CIFLOW_PENDING_MARKER));
}

/**
 * Create or update a comment explaining that ciflow labels are pending
 * workflow approval before CI can be triggered.
 */
async function upsertPendingComment(
  context: Context,
  prNum: number,
  pendingLabels: string[]
) {
  const body =
    CIFLOW_PENDING_MARKER +
    "\n" +
    "The following ciflow label(s) have been added but CI has not been triggered yet " +
    "because the workflows are awaiting approval:\n\n" +
    pendingLabels.map((l) => `- \`${l}\``).join("\n") +
    "\n\n" +
    "Once a maintainer approves the workflows (scroll to the bottom of the PR page), " +
    "the corresponding CI jobs will be triggered automatically. " +
    "Please ping one of the reviewers if you do not have access to approve and run workflows.";

  const existing = await findPendingCiflowComment(context, prNum);
  if (existing) {
    await context.octokit.issues.updateComment(
      context.repo({ comment_id: existing.id, body })
    );
  } else {
    await context.octokit.issues.createComment(
      context.repo({ body, issue_number: prNum })
    );
  }
}

/**
 * Edit the pending comment to indicate that CI has now been triggered.
 */
async function resolvePendingComment(context: Context, prNum: number) {
  const existing = await findPendingCiflowComment(context, prNum);
  if (existing) {
    const body =
      CIFLOW_PENDING_MARKER +
      "\n" +
      "~~Workflows were awaiting approval.~~ " +
      "CI has now been triggered for the ciflow labels on this PR.";
    await context.octokit.issues.updateComment(
      context.repo({ comment_id: existing.id, body })
    );
  }
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
    context.log.info(
      "PR does not have permissions to run workflows, skipping tag sync"
    );
    // Don't remove labels -- they represent user intent.
    // Tags simply won't be created until workflows are approved.
    return;
  }

  const headSha = payload.pull_request.head.sha;
  const tags = getAllPRTags(context, payload);
  const promises = tags.map(
    async (tag) => await syncTag(context, tag, headSha)
  );
  await Promise.all(promises);

  // If we successfully synced tags, resolve any pending comment
  if (tags.length > 0) {
    await resolvePendingComment(context, payload.pull_request.number);
  }

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
    // Keep the label (it represents user intent) but don't create the tag.
    // Post/update a pending comment listing all ciflow labels awaiting approval.
    const allCiflowLabels = payload.pull_request.labels
      .map((l) => l.name)
      .filter(isCIFlowLabel);
    if (!allCiflowLabels.includes(label)) {
      allCiflowLabels.push(label);
    }
    await upsertPendingComment(context, prNum, allCiflowLabels);
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

/**
 * When a workflow_run is requested (e.g. a maintainer clicks "Approve and run"),
 * check if the associated PR has pending ciflow labels and create the tags.
 */
async function handleWorkflowRunEvent(context: Context<"workflow_run">) {
  const payload = context.payload;

  // Only care about pull_request workflow runs
  if (payload.workflow_run.event !== "pull_request") {
    return;
  }

  let prNumbers: number[] = (payload.workflow_run.pull_requests ?? []).map(
    (pr: any) => pr.number
  );

  // For cross-fork PRs, the pull_requests array is empty.
  // Fall back to searching for PRs by the fork's owner and branch name.
  if (prNumbers.length === 0) {
    const headRepo = payload.workflow_run.head_repository;
    const headBranch = payload.workflow_run.head_branch;
    if (headRepo && headBranch) {
      const head = `${headRepo.owner.login}:${headBranch}`;
      context.log.info(
        `workflow_run has empty pull_requests, looking up PRs with head=${head}`
      );
      const prs = await context.octokit.pulls.list(
        context.repo({ head, state: "open" })
      );
      prNumbers = prs.data.map((pr) => pr.number);
    }
  }

  if (prNumbers.length === 0) {
    return;
  }

  for (const prNum of prNumbers) {
    const prData = await context.octokit.pulls.get(
      context.repo({ pull_number: prNum })
    );

    if (prData.data.state === "closed") {
      continue;
    }

    const ciflowLabels = prData.data.labels
      .map((l: any) => l.name)
      .filter(isCIFlowLabel);

    if (ciflowLabels.length === 0) {
      continue;
    }

    const headSha = prData.data.head.sha;
    const tags = ciflowLabels.map((l: string) => labelToTag(l, prNum));
    const promises = tags.map(
      async (tag: string) => await syncTag(context as any, tag, headSha)
    );
    await Promise.all(promises);

    await resolvePendingComment(context as any, prNum);
  }
}

export default function ciflowPushTrigger(app: Probot) {
  const tracker = new CachedConfigTracker(app);
  app.on("pull_request.labeled", async (context) => {
    const owner = context.payload.repository.owner.login;
    if (!isPyTorchbotSupportedOrg(owner)) {
      context.log(`${__filename} isn't enabled on ${owner}'s repos`);
      return;
    }
    await handleLabelEvent(context, context.payload, tracker);
  });

  app.on(
    [
      "pull_request.synchronize",
      "pull_request.opened",
      "pull_request.reopened",
    ],
    async (context) => {
      const owner = context.payload.repository.owner.login;
      if (!isPyTorchbotSupportedOrg(owner)) {
        context.log(`${__filename} isn't enabled on ${owner}'s repos`);
        return;
      }

      await handleSyncEvent(context, context.payload);
    }
  );
  app.on("pull_request.closed", async (context) => {
    const owner = context.payload.repository.owner.login;
    if (!isPyTorchbotSupportedOrg(owner)) {
      context.log(`${__filename} isn't enabled on ${owner}'s repos`);
      return;
    }

    await handleClosedEvent(context, context.payload);
  });
  app.on("pull_request.unlabeled", async (context) => {
    const owner = context.payload.repository.owner.login;
    if (!isPyTorchbotSupportedOrg(owner)) {
      context.log(`${__filename} isn't enabled on ${owner}'s repos`);
      return;
    }

    await handleUnlabeledEvent(context, context.payload);
  });

  // When a workflow run is requested (e.g. maintainer approves pending workflows),
  // create ciflow tags for any PR that has pending ciflow labels.
  app.on(
    ["workflow_run.requested", "workflow_run.completed"],
    async (context) => {
      const owner = context.payload.repository.owner.login;
      if (!isPyTorchbotSupportedOrg(owner)) {
        context.log(`${__filename} isn't enabled on ${owner}'s repos`);
        return;
      }

      await handleWorkflowRunEvent(context);
    }
  );
}
