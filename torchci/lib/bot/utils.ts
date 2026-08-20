import dayjs from "dayjs";
import { Octokit } from "octokit";
import { Context, Probot } from "probot";
import urllib from "urllib";

export function isTime0(time: string): boolean {
  const v = dayjs.utc(time).valueOf();
  // NB: This returns NaN when the string is empty
  return isNaN(v) || v === 0;
}

export const TIME_0 = "1970-01-01 00:00:00.000000000";

export function repoKey(context: Context): string {
  const repo = context.repo();
  return `${repo.owner}/${repo.repo}`;
}

export function isVLLM(owner: string): boolean {
  return owner === "vllm-project";
}

export function isPyTorchbotSupportedOrg(owner: string): boolean {
  // We frequently test CI changes on malfet/deleteme
  return owner === "pytorch" || owner === "meta-pytorch" || owner === "malfet";
}

export function isPyTorchPyTorch(owner: string, repo: string): boolean {
  return owner === "pytorch" && repo === "pytorch";
}

export function isDrCIEnabled(owner: string, repo: string): boolean {
  return (
    isPyTorchbotSupportedOrg(owner) &&
    [
      "pytorch",
      "vision",
      "text",
      "audio",
      "pytorch-canary",
      "tutorials",
      "executorch",
      "rl",
      "torchtune",
      "ao",
      "torchchat",
      "torchcodec",
      "tensordict",
    ].includes(repo)
  );
}

function retainLastKnownGood(
  context: Context,
  lastKnownGood: any,
  key: string,
  error: unknown
): any {
  // A repo with no config file resolves to null, so membership rather than
  // truthiness decides whether an earlier fetch ever succeeded.
  if (!(key in lastKnownGood)) {
    throw error;
  }
  context.log.error(
    { key, err: error },
    "config fetch failed, serving the last known good value"
  );
  return lastKnownGood[key];
}

export class CachedConfigTracker {
  repoConfigs: any = {};
  lastKnownGoodConfigs: any = {};

  constructor(app: Probot) {
    app.on("push", async (context) => {
      if (
        context.payload.ref === "refs/heads/master" ||
        context.payload.ref === "refs/heads/main"
      ) {
        delete this.repoConfigs[repoKey(context)];
      }
    });
  }

  async loadConfig(context: Context, force = false): Promise<object> {
    const key = repoKey(context);
    if (!(key in this.repoConfigs) || force) {
      context.log({ key }, "loadConfig");
      try {
        this.repoConfigs[key] = await context.config("pytorch-probot.yml");
        this.lastKnownGoodConfigs[key] = this.repoConfigs[key];
      } catch (error) {
        // A forced read leaves the previous value in place; dropping it keeps
        // the key stale so the next read retries the fetch.
        delete this.repoConfigs[key];
        return retainLastKnownGood(
          context,
          this.lastKnownGoodConfigs,
          key,
          error
        );
      }
    }
    return this.repoConfigs[key];
  }
}

export class CachedIssueTracker extends CachedConfigTracker {
  repoIssues: any = {};
  configName: string;
  issueParser: (_data: string) => object;

  constructor(
    app: Probot,
    configName: string,
    issueParser: (_data: string) => object
  ) {
    super(app);
    this.configName = configName;
    this.issueParser = issueParser;

    app.on("issues.edited", async (context) => {
      const config: any = await this.loadConfig(context);
      const issue = context.issue();
      if (config[this.configName] === issue.issue_number) {
        await this.loadIssue(context, /* force */ true);
      }
    });
  }

  async loadIssue(context: Context, force = false): Promise<object> {
    const key = repoKey(context);
    if (!(key in this.repoIssues) || force) {
      context.log({ key }, "loadIssue");
      const config: any = await this.loadConfig(context);
      if (config != null && this.configName in config) {
        const subsPayload = await context.octokit.issues.get(
          context.repo({ issue_number: config[this.configName] })
        );
        const subsText = subsPayload.data["body"];
        context.log({ subsText });
        this.repoIssues[key] = this.issueParser(subsText!);
      } else {
        context.log(
          `${this.configName} is not found in config, initializing with empty string`
        );
        this.repoIssues[key] = this.issueParser("");
      }
      context.log({ parsedIssue: this.repoIssues[key] });
    }
    return this.repoIssues[key];
  }
}

export class CachedLabelerConfigTracker extends CachedConfigTracker {
  repoLabels: any = {};
  lastKnownGoodLabels: any = {};
  constructor(app: Probot) {
    super(app);
    app.on("push", async (context) => {
      if (
        context.payload.ref === "refs/heads/master" ||
        context.payload.ref === "refs/heads/main"
      ) {
        const key = repoKey(context);
        delete this.repoConfigs[key];
        delete this.repoLabels[key];
      }
    });
  }

  async loadLabelsConfig(context: Context, force = false): Promise<object> {
    const key = repoKey(context);
    if (!(key in this.repoLabels) || force) {
      let config: any;
      try {
        config = await this.loadConfig(context, force);
      } catch (error) {
        return retainLastKnownGood(
          context,
          this.lastKnownGoodLabels,
          key,
          error
        );
      }

      if (config != null && "labeler_config" in config) {
        this.repoLabels[key] = context.config(config["labeler_config"]);
      } else {
        this.repoLabels[key] = {};
      }
    }
    // The cache holds the unsettled fetch itself so concurrent readers share it.
    const pending = this.repoLabels[key];
    try {
      const labels = await pending;
      this.lastKnownGoodLabels[key] = labels;
      return labels;
    } catch (error) {
      if (this.repoLabels[key] === pending) {
        delete this.repoLabels[key];
      }
      return retainLastKnownGood(context, this.lastKnownGoodLabels, key, error);
    }
  }
}

export class LabelToLabelConfigTracker extends CachedConfigTracker {
  repoLabels: any = {};
  lastKnownGoodLabels: any = {};
  constructor(app: Probot) {
    super(app);
    app.on("push", async (context) => {
      if (
        context.payload.ref === "refs/heads/master" ||
        context.payload.ref === "refs/heads/main"
      ) {
        const key = repoKey(context);
        delete this.repoConfigs[key];
        delete this.repoLabels[key];
      }
    });
  }

  async loadLabelsConfig(context: Context, force = false): Promise<object> {
    const key = repoKey(context);
    if (!(key in this.repoLabels) || force) {
      let config: any;
      try {
        config = await this.loadConfig(context, force);
      } catch (error) {
        return retainLastKnownGood(
          context,
          this.lastKnownGoodLabels,
          key,
          error
        );
      }

      if (config != null && "label_to_label_config" in config) {
        this.repoLabels[key] = context.config(config["label_to_label_config"]);
      } else {
        this.repoLabels[key] = {};
      }
    }
    // The cache holds the unsettled fetch itself so concurrent readers share it.
    const pending = this.repoLabels[key];
    try {
      const labels = await pending;
      this.lastKnownGoodLabels[key] = labels;
      return labels;
    } catch (error) {
      if (this.repoLabels[key] === pending) {
        delete this.repoLabels[key];
      }
      return retainLastKnownGood(context, this.lastKnownGoodLabels, key, error);
    }
  }
}

// returns undefined if the request fails
export async function fetchJSON(path: string): Promise<any> {
  const result = await retryRequest(path);
  if (result.res.statusCode !== 200) {
    return;
  }
  return JSON.parse(result.data.toString());
}

export async function retryRequest(
  path: string,
  numRetries: number = 3,
  delay: number = 500
): Promise<urllib.HttpClientResponse<any>> {
  for (let i = 0; i < numRetries; i++) {
    const result = await urllib.request(path);
    if (result.res.statusCode == 200) {
      return result;
    }
    await new Promise((f) => setTimeout(f, delay));
  }
  return await urllib.request(path);
}
export async function reactOnComment(ctx: any, reaction: "+1" | "confused") {
  ctx.log(
    `Reacting with "${reaction}" to comment ${ctx.payload.comment.html_url}`
  );
  await ctx.octokit.reactions.createForIssueComment({
    comment_id: ctx.payload.comment.id,
    content: reaction,
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
  });
}

export async function addComment(ctx: any, message: string) {
  ctx.log(
    `Commenting with "${message}" on issue ${ctx.payload.issue.html_url}`
  );
  await ctx.octokit.issues.createComment({
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    issue_number: ctx.payload.issue.number,
    body: message,
  });
}

export async function addLabels(ctx: any, labelsToAdd: string[]) {
  if (ctx.payload.issue) {
    ctx.log(
      `Adding label(s) ${labelsToAdd} to issue ${ctx.payload.issue.html_url}`
    );
  }
  if (ctx.payload.pull_request) {
    ctx.log(
      `Adding label(s) ${labelsToAdd} to pull request ${ctx.payload.pull_request.html_url}`
    );
  }
  await ctx.octokit.issues.addLabels(ctx.issue({ labels: labelsToAdd }));
}

export async function getUserPermissions(
  ctx: any,
  username: string
): Promise<string> {
  const res = await ctx.octokit.repos.getCollaboratorPermissionLevel({
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    username,
  });
  return res?.data?.permission;
}

export async function hasWritePermissions(
  ctx: any,
  username: string
): Promise<boolean> {
  // GitHub Apps authenticate via installations, not as repo collaborators,
  // so the collaborator permission check doesn't apply to them.
  if (
    username === "facebook-github-tools[bot]" ||
    username === "meta-codesync[bot]"
  ) {
    return true;
  }
  const permissions = await getUserPermissions(ctx, username);
  return permissions === "admin" || permissions === "write";
}

export async function hasApprovedPullRuns(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string
): Promise<boolean> {
  const res = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner: owner,
    repo: repo,
    head_sha: sha,
  });
  const pr_runs = res?.data?.workflow_runs?.filter(
    (run) => run.event == "pull_request"
  );
  if (pr_runs == null || pr_runs?.length == 0) {
    return false;
  }
  return !pr_runs.some(
    (run) =>
      run.conclusion === "action_required" ||
      // See https://github.com/pytorch/test-infra/pull/6329 about difference
      // between these two
      run.conclusion === "startup_failure" ||
      (run.conclusion === "failure" && run.created_at == run.updated_at)
  );
}

export async function isFirstTimeContributor(
  ctx: any,
  username: string
): Promise<boolean> {
  const commits = await ctx.octokit.repos.listCommits({
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    author: username,
    sha: ctx.payload.repository.default_branch,
    per_page: 1,
  });
  return commits?.data?.length === 0;
}

export async function getFilesChangedByPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  const filesChangedRes = await octokit.paginate(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }
  );
  return filesChangedRes.map((f: any) => f.filename);
}

export const FILES_CHANGED_CACHE_TTL_MS = 60 * 1000;

interface FilesChangedCacheEntry {
  promise: Promise<string[]>;
  expiresAt: number;
}

// autoLabelBot and nitpickBot both fetch a PR's changed files on the same
// pull_request delivery, staggered (nitpick loads its config first). Caching
// the resolved fetch — not just the in-flight promise — lets the second
// handler reuse the first's paginated GET /pulls/{n}/files. The delivery id
// scopes an entry to a single webhook delivery: GitHub computes the file list
// against the PR's base, and retargeting the base changes that list without
// changing head.sha, so an entry is only ever safe to reuse within the
// delivery that produced it. The TTL only bounds memory.
const filesChangedCache = new Map<string, FilesChangedCacheEntry>();

export function getFilesChangedByPrCached(
  octokit: Octokit,
  deliveryId: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<string[]> {
  const key = `${deliveryId}/${owner}/${repo}/${prNumber}/${headSha}`;
  const now = Date.now();

  const cached = filesChangedCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  for (const [k, entry] of filesChangedCache) {
    if (entry.expiresAt <= now) {
      filesChangedCache.delete(k);
    }
  }

  const promise = getFilesChangedByPr(octokit, owner, repo, prNumber);
  filesChangedCache.set(key, {
    promise,
    expiresAt: now + FILES_CHANGED_CACHE_TTL_MS,
  });
  // A failed fetch must not be served for the rest of the TTL; drop it so a
  // later handler re-fetches (matching the uncached on-error behavior).
  promise.catch(() => {
    if (filesChangedCache.get(key)?.promise === promise) {
      filesChangedCache.delete(key);
    }
  });

  return promise;
}

/** Clear the in-memory files-changed cache (useful for testing). */
export function clearFilesChangedCache(): void {
  filesChangedCache.clear();
}
