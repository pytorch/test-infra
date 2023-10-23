import { Context, Probot } from "probot";
import urllib from "urllib";
import { Octokit } from "octokit";

export function repoKey(
  context: Context | Context<"pull_request.labeled">
): string {
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

  async loadConfig(
    context: Context | Context<"pull_request.labeled">,
    force = false
  ): Promise<object> {
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
  issueParser: (data: string) => object;

  constructor(
    app: Probot,
    configName: string,
    issueParser: (data: string) => object
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

export async function hasWritePermissionsUsingOctokit(
  octokit: Octokit,
  username: string,
  owner: string,
  repo: string
): Promise<boolean> {
  const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner: owner,
    repo: repo,
    username: username,
  });
  const permissions = res?.data?.permission;
  return permissions === "admin" || permissions === "write";
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

export async function hasWorkflowRunningPermissions(
  ctx: any,
  username: string
): Promise<boolean> {
  return (
    (await hasWritePermissions(ctx, username)) ||
    !(await isFirstTimeContributor(ctx, username))
  );
}
