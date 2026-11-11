import type { ReleaseConfig } from "lib/api/releases/types";
import { getOctokit } from "lib/github";
import { Octokit } from "octokit";
import { z } from "zod/v4";

// Finds a release's milestone, tracker issue and validation issue on GitHub by the
// rules in the release config's `discovery` block (release/portal/config/steps.yml),
// the same rules tools/torchci/release_portal_config.py applies for the collector.
// The milestone is the one titled with the version; an issue is found by a GitHub
// search and a title pattern, the newest match winning.

export interface FoundObject {
  number: number;
  title: string;
  url: string;
}
export interface DiscoveredLinks {
  milestone: FoundObject | null;
  tracker_issue: FoundObject | null;
  validation_issue: FoundObject | null;
}
export const NOTHING_FOUND: DiscoveredLinks = {
  milestone: null,
  tracker_issue: null,
  validation_issue: null,
};

const MilestoneRuleSchema = z.object({ repo: z.string(), title: z.string() });
const IssueRuleSchema = z.object({
  repo: z.string(),
  query: z.string(),
  title_regex: z.union([
    z.string(),
    z.object({ minor: z.string(), patch: z.string() }),
  ]),
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fill(template: string, version: string, escape: boolean): string {
  const minor = version.split(".").slice(0, 2).join(".");
  const values: Record<string, string> = { version, minor };
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    escape ? escapeRegExp(values[name]) : values[name]
  );
}

export function milestoneTitle(
  rule: { title: string },
  version: string
): string {
  return fill(rule.title, version, false);
}

export function issueTitlePattern(
  rule: z.infer<typeof IssueRuleSchema>,
  version: string,
  type: "minor" | "patch"
): RegExp {
  const template =
    typeof rule.title_regex === "string"
      ? rule.title_regex
      : rule.title_regex[type];
  return new RegExp(fill(template, version, true));
}

// The newest issue (highest number) whose title matches; pull requests never do.
export function newestMatching(
  issues: {
    number: number;
    title: string;
    html_url: string;
    pull_request?: unknown;
  }[],
  pattern: RegExp
): FoundObject | null {
  const matches = issues.filter(
    (issue) => issue.pull_request === undefined && pattern.test(issue.title)
  );
  if (matches.length === 0) return null;
  const newest = matches.reduce((a, b) => (b.number > a.number ? b : a));
  return { number: newest.number, title: newest.title, url: newest.html_url };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; links: DiscoveredLinks }>();

export function clearDiscoveryCache(): void {
  cache.clear();
}

// Everything discovery reads is public: the milestones and issues of a public repo. So
// without the GitHub App's credentials it asks GitHub unauthenticated. That is what a
// preview deployment does, which must not hold PyTorchBot's write-scoped key, and it
// is enough for the five-minute cache below. The credentials, when set, give the
// higher rate limit.
async function discoveryOctokit(owner: string, repo: string): Promise<Octokit> {
  if (process.env.APP_ID && process.env.PRIVATE_KEY) {
    return getOctokit(owner, repo);
  }
  return new Octokit();
}

async function discover(config: ReleaseConfig): Promise<DiscoveredLinks> {
  const rules = z
    .object({
      milestone: MilestoneRuleSchema,
      tracker_issue: IssueRuleSchema,
      validation_issue: IssueRuleSchema,
    })
    .parse(config.discovery);
  const [owner, repo] = rules.milestone.repo.split("/");
  const octokit = await discoveryOctokit(owner, repo);
  const version = config.release;

  const title = milestoneTitle(rules.milestone, version);
  const milestones = await octokit.paginate(
    octokit.rest.issues.listMilestones,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
    }
  );
  const milestone = milestones.find((m) => m.title === title);

  async function issue(rule: z.infer<typeof IssueRuleSchema>) {
    const found = await octokit.rest.search.issuesAndPullRequests({
      q: `repo:${rule.repo} is:issue ${rule.query}`,
      sort: "created",
      order: "desc",
      per_page: 100,
    });
    return newestMatching(
      found.data.items,
      issueTitlePattern(rule, version, config.type)
    );
  }

  return {
    milestone: milestone
      ? {
          number: milestone.number,
          title: milestone.title,
          url: milestone.html_url,
        }
      : null,
    tracker_issue: await issue(rules.tracker_issue),
    validation_issue: await issue(rules.validation_issue),
  };
}

// The release's objects, from GitHub, kept for five minutes. A failure costs the board
// its links and nothing else: they come back null, and the next request asks again.
export async function discoverLinks(
  config: ReleaseConfig
): Promise<DiscoveredLinks> {
  const hit = cache.get(config.release);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.links;
  try {
    const links = await discover(config);
    cache.set(config.release, { at: Date.now(), links });
    return links;
  } catch (error) {
    console.warn(
      `could not find ${config.release}'s milestone and issues:`,
      error
    );
    return hit?.links ?? NOTHING_FOUND;
  }
}
