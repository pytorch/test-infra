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

export function isPyTorchOrg(owner: string): boolean {
  return owner === "pytorch";
}

export function isPyTorchPyTorch(owner: string, repo: string): boolean {
  return isPyTorchOrg(owner) && repo === "pytorch";
}

export function isDrCIEnabled(owner: string, repo: string): boolean {
  return (
    isPyTorchOrg(owner) &&
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
    ].includes(repo)
  );
}

export class CachedConfigTracker {
  repoConfigs: any = {};

  constructor(app: Probot) {
    app.on("push", async (context) => {
      if (
        context.payload.ref === "refs/heads/master" ||
        context.payload.ref === "refs/heads/main"
      ) {
        await this.loadConfig(context, /* force */ true);
      }
    });
  }

  async loadConfig(context: Context, force = false): Promise<object> {
    const key = repoKey(context);
    if (!(key in this.repoConfigs) || force) {
      context.log({ key }, "loadConfig");
      this.repoConfigs[key] = await context.config("pytorch-probot.yml");
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
  constructor(app: Probot) {
    super(app);
    app.on("push", async (context) => {
      if (
        context.payload.ref === "refs/heads/master" ||
        context.payload.ref === "refs/heads/main"
      ) {
        await this.loadLabelsConfig(context, /* force */ true);
      }
    });
  }

  async loadLabelsConfig(context: Context, force = false): Promise<object> {
    const key = repoKey(context);
    if (!(key in this.repoLabels) || force) {
      const config: any = await this.loadConfig(context, force);

      if (config != null && "labeler_config" in config) {
        this.repoLabels[key] = context.config(config["labeler_config"]);
      } else {
        this.repoLabels[key] = {};
      }
    }
    return this.repoLabels[key];
  }
}

export class LabelToLabelConfigTracker extends CachedConfigTracker {
  repoLabels: any = {};
  constructor(app: Probot) {
    super(app);
    app.on("push", async (context) => {
      if (
        context.payload.ref === "refs/heads/master" ||
        context.payload.ref === "refs/heads/main"
      ) {
        await this.loadLabelsConfig(context, /* force */ true);
      }
    });
  }

  async loadLabelsConfig(context: Context, force = false): Promise<object> {
    const key = repoKey(context);
    if (!(key in this.repoLabels) || force) {
      const config: any = await this.loadConfig(context, force);

      if (config != null && "label_to_label_config" in config) {
        this.repoLabels[key] = context.config(config["label_to_label_config"]);
      } else {
        this.repoLabels[key] = {};
      }
    }
    return this.repoLabels[key];
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
