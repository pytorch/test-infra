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
export async function reactOnComment(
  ctx: any,
  reaction: "+1" | "-1" | "confused"
) {
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
    username === "meta-codesync[bot]" ||
    username === "dependabot[bot]"
  ) {
    return true;
  }
  const permissions = await getUserPermissions(ctx, username);
  return permissions === "admin" || permissions === "write";
}

// Triage or higher on owner/repo. The legacy `permission` field reports triage
// as "read", so this reads the granular permissions and the role name. A 404
// (no such user) is no permission; any other error propagates.
export async function hasTriageOrHigherPermissions(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string
): Promise<boolean> {
  let data;
  try {
    data = (
      await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
      })
    ).data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return false;
    }
    throw error;
  }
  const p = data.user?.permissions;
  return (
    Boolean(p?.triage || p?.push || p?.maintain || p?.admin) ||
    ["triage", "write", "maintain", "admin"].includes(data.role_name)
  );
}

// Answers "did we VERIFY this user as an active member of org/teamSlug?" —
// a false is "not verified", which is weaker than "not a member".
//
// Fails closed. The call needs the app's `members:read` org permission, and
// GitHub can answer 404 for a genuine non-member, for a team that does not
// exist, and for one the token cannot read alike. Every non-success — a 404, a
// 403 from a missing grant, a transport error — resolves to false, so a broken
// lookup can never widen access. Callers must word their own logs and
// user-facing messages as "could not verify" rather than "is not a member".
export async function isOrgTeamMember(
  ctx: any,
  org: string,
  teamSlug: string,
  username: string
): Promise<boolean> {
  // App principals are not org members, and the memberships endpoint 404s for
  // a `[bot]` login, so the call can only answer false for them. The falsy
  // check keeps `.endsWith` from throwing past the try below, where a throw
  // would skip the caller's enforcement instead of denying.
  if (!username || username.endsWith("[bot]")) {
    return false;
  }
  try {
    const res = await ctx.octokit.teams.getMembershipForUserInOrg({
      org,
      team_slug: teamSlug,
      username,
    });
    return res?.data?.state === "active";
  } catch (error) {
    // Log, but never let logging decide the answer: a throw from here would
    // escape the catch and skip the caller's enforcement entirely.
    try {
      if ((error as any)?.status === 404) {
        // A 404 here is ambiguous — not a member, no such team, or a team this
        // token cannot read — and nothing at this call site can tell them
        // apart. Log it anyway so the ambiguity is visible: repeated 404s for
        // people independently known to be on the team are a reason to check
        // the team slug and the installation's access, not proof of either.
        ctx.log?.info?.(
          { org, teamSlug, username },
          "team membership lookup returned 404: not a member, no such team, or the team is not readable with this token"
        );
      } else {
        ctx.log?.error?.(
          { org, teamSlug, username, err: error },
          "team membership lookup failed, denying the exemption"
        );
      }
    } catch {
      // Logging is best effort.
    }
    return false;
  }
}

// Answers "did we VERIFY that this human has write or admin access to the
// event's repo?" Unlike hasWritePermissions, it fails closed: a lookup error
// resolves to false instead of throwing, and `[bot]` logins are always false,
// so no app inherits the facebook-github-tools / meta-codesync allowance.
export async function hasVerifiedHumanWritePermissions(
  ctx: any,
  username: string
): Promise<boolean> {
  if (!username || username.endsWith("[bot]")) {
    return false;
  }
  try {
    return await hasWritePermissions(ctx, username);
  } catch (error) {
    try {
      ctx.log?.error?.(
        { username, err: error },
        "collaborator permission lookup failed, denying write access"
      );
    } catch {
      // Logging is best effort.
    }
    return false;
  }
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

const GHSTACK_HEAD_REF = /^gh\/([^/]+)\/[0-9]+\/head$/;
const GHSTACK_LISTING_HEADER = "Stack from [ghstack]";
const GHSTACK_LISTING_ROW = /^\* (__->__ )?#([1-9][0-9]*)$/;
const GHSTACK_LISTING_PLACEHOLDER = "* (to be filled)";
const MAX_STACK_PRS_PER_QUERY = 100;

export type GhstackListing =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "stack"; above: number[]; below: number[] };

// ghstack writes the listing top of the stack first and marks the PR itself
// with `__->__`. It opens each new PR with the placeholder row and fills the
// listing in moments later with an edit.
export function parseGhstackListing(
  body: string | null | undefined,
  prNumber: number
): GhstackListing {
  const lines = (body ?? "").split("\n").map((line) => line.replace(/\r/g, ""));
  const numbers: number[] = [];
  const marked: number[] = [];
  let inListing = false;
  let firstRow = true;
  for (const line of lines) {
    if (line.startsWith(GHSTACK_LISTING_HEADER)) {
      inListing = true;
      continue;
    }
    if (!inListing) {
      continue;
    }
    const row = line.match(GHSTACK_LISTING_ROW);
    if (row === null) {
      if (firstRow && line === GHSTACK_LISTING_PLACEHOLDER) {
        return { kind: "pending" };
      }
      break;
    }
    firstRow = false;
    const number = parseInt(row[2]);
    if (row[1] !== undefined) {
      marked.push(number);
    }
    if (!numbers.includes(number)) {
      numbers.push(number);
    }
  }
  if (marked.length !== 1 || marked[0] !== prNumber) {
    return { kind: "none" };
  }
  const index = numbers.indexOf(prNumber);
  return {
    kind: "stack",
    above: numbers.slice(0, index).reverse(),
    below: numbers.slice(index + 1),
  };
}

export interface NativeStackField {
  position: number;
  size: number;
}

export interface StackPr {
  number: number;
  isDraft: boolean;
  labels: string[];
  files: string[];
}

export type StackDirection = "above" | "below";

export type OpenStackPrs =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "stack"; prs: StackPr[] };

const STACK_PR_FIELDS = `
fragment StackPrFields on PullRequest {
  number
  state
  isDraft
  isCrossRepository
  headRefName
  labels(first: 100) { nodes { name } }
  changedFiles
  files(first: 100) { nodes { path } }
}`;

interface StackPrNode {
  number: number;
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  headRefName: string;
  labels: { nodes: { name: string }[] };
  changedFiles: number;
  files: { nodes: { path: string }[] } | null;
}

function isOpenSameRepo(node: StackPrNode | null): node is StackPrNode {
  return node !== null && node.state === "OPEN" && !node.isCrossRepository;
}

async function toStackPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  node: StackPrNode
): Promise<StackPr> {
  const files = (node.files?.nodes ?? []).map((f) => f.path);
  return {
    number: node.number,
    isDraft: node.isDraft,
    labels: node.labels.nodes.map((l) => l.name),
    files:
      node.changedFiles > files.length
        ? await getFilesChangedByPr(octokit, owner, repo, node.number)
        : files,
  };
}

async function getOpenGhstackNodes(
  octokit: Octokit,
  owner: string,
  repo: string,
  user: string,
  numbers: number[]
): Promise<StackPrNode[]> {
  if (numbers.length === 0) {
    return [];
  }
  if (numbers.length > MAX_STACK_PRS_PER_QUERY) {
    throw new Error(
      `ghstack listing names ${numbers.length} PRs, more than ${MAX_STACK_PRS_PER_QUERY}`
    );
  }
  const params = numbers.map((_, i) => `$n${i}: Int!`).join(", ");
  const fields = numbers
    .map((_, i) => `pr${i}: pullRequest(number: $n${i}) { ...StackPrFields }`)
    .join("\n");
  const query = `query ($owner: String!, $repo: String!, ${params}) {
  repository(owner: $owner, name: $repo) {
${fields}
  }
}
${STACK_PR_FIELDS}`;
  const variables: Record<string, string | number> = { owner, repo };
  numbers.forEach((n, i) => {
    variables[`n${i}`] = n;
  });
  const res: any = await octokit.graphql(query, variables);
  return numbers
    .map((_, i): StackPrNode | null => res?.repository?.[`pr${i}`] ?? null)
    .filter(isOpenSameRepo)
    .filter((node) => node.headRefName.match(GHSTACK_HEAD_REF)?.[1] === user);
}

const NATIVE_STACK_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      stack {
        entries(first: 100) {
          totalCount
          pageInfo { hasNextPage }
          nodes { position pullRequest { ...StackPrFields } }
        }
      }
    }
  }
}
${STACK_PR_FIELDS}`;

async function getOpenNativeStackNodes(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  direction: StackDirection
): Promise<StackPrNode[] | null> {
  const res: any = await octokit.graphql(NATIVE_STACK_QUERY, {
    owner,
    repo,
    number: prNumber,
  });
  const stack = res?.repository?.pullRequest?.stack;
  if (stack === null || stack === undefined) {
    return null;
  }
  const page = stack.entries;
  const nodes: any[] = page?.nodes ?? [];
  if (
    page?.pageInfo?.hasNextPage ||
    page?.totalCount !== nodes.length ||
    nodes.some((node) => node === null || node.pullRequest === null)
  ) {
    throw new Error(
      `could not read all ${page?.totalCount} PRs in the stack of PR #${prNumber}`
    );
  }
  const entries: StackPrNode[] = [...nodes]
    .sort((a, b) => a.position - b.position)
    .map((node) => node.pullRequest);
  const here = entries.findIndex((pr) => pr.number === prNumber);
  if (
    here === -1 ||
    entries.some((pr, i) => i !== here && pr.number === prNumber)
  ) {
    throw new Error(`the stack entries do not list PR #${prNumber} once`);
  }
  const inDirection =
    direction === "above"
      ? entries.slice(here + 1)
      : entries.slice(0, here).reverse();
  return inDirection.filter(isOpenSameRepo);
}

// Ref.compare(headRef) against the lower PR's ref as base: behindBy == 0 means
// every commit of the lower ref is in the upper ref. A ref that does not
// exist resolves to null (base) or a NOT_FOUND error with a null comparison
// (head); either way that pair is not contained.
async function filterContained(
  octokit: Octokit,
  owner: string,
  repo: string,
  subjectRef: string,
  nodes: StackPrNode[],
  refOf: (_node: StackPrNode) => string,
  direction: StackDirection
): Promise<StackPrNode[]> {
  if (nodes.length === 0) {
    return [];
  }
  const params = nodes.map((_, i) => `$b${i}: String!, $h${i}: String!`);
  const fields = nodes.map(
    (_, i) =>
      `c${i}: ref(qualifiedName: $b${i}) { compare(headRef: $h${i}) { behindBy status } }`
  );
  const query = `query ($owner: String!, $repo: String!, ${params.join(", ")}) {
  repository(owner: $owner, name: $repo) {
${fields.join("\n")}
  }
}`;
  const variables: Record<string, string> = { owner, repo };
  nodes.forEach((node, i) => {
    const [lower, upper] =
      direction === "above"
        ? [subjectRef, refOf(node)]
        : [refOf(node), subjectRef];
    variables[`b${i}`] = `refs/heads/${lower}`;
    variables[`h${i}`] = `refs/heads/${upper}`;
  });
  let res: any;
  try {
    res = await octokit.graphql(query, variables);
  } catch (error) {
    const e = error as { data?: unknown; errors?: { type?: string }[] };
    if (
      e.data === undefined ||
      e.data === null ||
      !e.errors?.every((err) => err.type === "NOT_FOUND")
    ) {
      throw error;
    }
    res = e.data;
  }
  return nodes.filter(
    (_, i) => res?.repository?.[`c${i}`]?.compare?.behindBy === 0
  );
}

const ghstackOrigRef = (headRef: string) => headRef.replace(/\/head$/, "/orig");

/**
 * The open same-repo PRs above or below a PR in its stack, nearest first,
 * that contain the PR's current changes (above) or whose current changes the
 * PR contains (below): a ghstack (head ref gh/<user>/<n>/head and ghstack's
 * listing in the body; containment of the gh/<user>/<n>/orig branches) or a
 * GitHub-native stack (the `stack` field of the pull_request object;
 * containment of the head branches). A cross-repository PR is never stacked.
 * "pending" means ghstack has not filled the listing in yet.
 */
export async function getOpenStackPrs(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: {
    number: number;
    body: string | null | undefined;
    headRef: string;
    isCrossRepository: boolean;
    stack?: NativeStackField | null;
  },
  direction: StackDirection
): Promise<OpenStackPrs> {
  if (pr.isCrossRepository) {
    return { kind: "none" };
  }
  let nodes: StackPrNode[];
  let refOf: (_headRef: string) => string;
  const user = pr.headRef.match(GHSTACK_HEAD_REF)?.[1];
  if (user !== undefined) {
    const listing = parseGhstackListing(pr.body, pr.number);
    if (listing.kind !== "stack") {
      return listing;
    }
    nodes = await getOpenGhstackNodes(
      octokit,
      owner,
      repo,
      user,
      listing[direction]
    );
    refOf = ghstackOrigRef;
  } else if (pr.stack) {
    if (
      (direction === "above" && pr.stack.position >= pr.stack.size) ||
      (direction === "below" && pr.stack.position <= 1)
    ) {
      return { kind: "stack", prs: [] };
    }
    const native = await getOpenNativeStackNodes(
      octokit,
      owner,
      repo,
      pr.number,
      direction
    );
    if (native === null) {
      return { kind: "none" };
    }
    nodes = native;
    refOf = (headRef) => headRef;
  } else {
    return { kind: "none" };
  }
  const contained = await filterContained(
    octokit,
    owner,
    repo,
    refOf(pr.headRef),
    nodes,
    (node) => refOf(node.headRefName),
    direction
  );
  const prs: StackPr[] = [];
  for (const node of contained) {
    prs.push(await toStackPr(octokit, owner, repo, node));
  }
  return { kind: "stack", prs };
}
