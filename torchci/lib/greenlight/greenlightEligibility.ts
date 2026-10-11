// What greenlight's scan would decide for a PR it has no non-shadow state for,
// read from the same sources it reads. The merge-rule semantics are ports of
// greenlight/src/greenlight/merge_authz.py, cohort.evaluation_cohort and
// cohort.assess_rules, and the size caps of the ones in
// .github/workflows/greenlight-pr-review.yml: they must change together, or this
// line promises a review the scan will not run.

import yaml from "js-yaml";
import { getFilesChangedByPr } from "lib/bot/utils";
import { GREENLIGHT_APP_SLUG } from "lib/greenlight/greenlightConfig";
import {
  GREENLIGHT_IN_PROGRESS_EMOJI,
  GREENLIGHT_NEEDS_HUMAN_EMOJI,
} from "lib/greenlight/greenlightRender";
import { isBot, isHumanDecided } from "lib/greenlight/greenlightReviewGate";
import { Octokit } from "octokit";

export type GreenlightEligibility = "too_big" | "merge_rules" | "waiting";

// The fields read from a pulls.get response or a pull_request webhook payload.
export interface EligibilityPr {
  number: number;
  draft?: boolean;
  user: { login: string } | null;
  additions: number;
  deletions: number;
  changed_files: number;
  head: { ref: string };
  base: { ref: string };
}

export type EligibilityCheck = (
  _pr: EligibilityPr
) => Promise<GreenlightEligibility | null>;

interface MergeRule {
  logins: string[];
  teams: string[];
  // null when the rule's patterns are unusable: it covers nothing.
  matches: ((_path: string) => boolean) | null;
  coversAll: boolean;
}

const MERGE_RULES_FILE = {
  owner: "pytorch",
  repo: "pytorch",
  path: ".github/merge_rules.yaml",
};
const TARGET_BRANCH = "main";
const MAX_DIFF_LINES = 2000;
const MAX_DIFF_FILES = 200;
const GHSTACK_HEAD_REF_RE = /^gh\/[^/]+\/[0-9]+\/head$/;
const TEAM_REF_RE = /^[^/]+\/[^/]+$/;

// Python's str.strip set. String.prototype.trim differs: it also strips U+FEFF,
// which would read a BOM-padded approved_by entry differently from Python.
const PY_SPACE =
  "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_STRIP_RE = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");

const INVALID_PATTERN_CHARS_RE = /[{}()[\]\\]/;
const GLOB_TOKEN_RE = /\*\*|[*.+]/g;
const GLOB_TOKEN_REGEX: Record<string, string> = {
  "**": ".*",
  "*": "[^/]*",
  ".": "\\.",
  "+": "\\+",
};

const ELIGIBILITY_LAMP: Record<GreenlightEligibility, string> = {
  too_big: GREENLIGHT_NEEDS_HUMAN_EMOJI,
  merge_rules: GREENLIGHT_NEEDS_HUMAN_EMOJI,
  waiting: GREENLIGHT_IN_PROGRESS_EMOJI,
};
const ELIGIBILITY_STATUS: Record<GreenlightEligibility, string> = {
  too_big: "changes are too big to review",
  merge_rules: "changes can't be reviewed due to merge_rules.yaml restrictions",
  waiting: "waiting for review to start",
};

function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, "");
}

function patternsToRegex(patterns: string[]): RegExp {
  const invalid = patterns.find((p) => INVALID_PATTERN_CHARS_RE.test(p));
  if (invalid !== undefined) {
    throw new Error(
      `pattern contains invalid characters (braces/parens/brackets/backslash): ${JSON.stringify(
        invalid
      )}`
    );
  }
  const alternatives = patterns.map((p) =>
    p.replace(GLOB_TOKEN_RE, (token) => GLOB_TOKEN_REGEX[token])
  );
  // Anchored at the start only: trymerge matches with Python's re.match.
  return new RegExp(`^(${alternatives.join("|")})`);
}

export function compilePatterns(
  patterns: string[]
): (_path: string) => boolean {
  const include = patternsToRegex(patterns.filter((p) => !p.startsWith("-")));
  const negative = patterns
    .filter((p) => p.startsWith("-"))
    .map((p) => p.slice(1));
  const exclude = negative.length > 0 ? patternsToRegex(negative) : null;
  return (path) =>
    include.test(path) && (exclude === null || !exclude.test(path));
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(rule: unknown): MergeRule {
  if (!isMapping(rule)) {
    throw new Error(
      `merge rule must be a mapping, got ${JSON.stringify(rule)}`
    );
  }
  const approvedBy = rule.approved_by === undefined ? [] : rule.approved_by;
  if (!Array.isArray(approvedBy)) {
    throw new Error(
      `approved_by must be a list, got ${JSON.stringify(approvedBy)}`
    );
  }
  const logins: string[] = [];
  const teams: string[] = [];
  for (const entry of approvedBy) {
    if (typeof entry !== "string" || pyStrip(entry) === "") {
      throw new Error(
        `approved_by entry must be a non-empty string, got ${JSON.stringify(
          entry
        )}`
      );
    }
    if (!entry.includes("/")) {
      logins.push(entry);
    } else if (TEAM_REF_RE.test(entry)) {
      teams.push(entry);
    } else {
      throw new Error(
        `approved_by team ref must be 'org/team-slug', got ${JSON.stringify(
          entry
        )}`
      );
    }
  }
  const { name, patterns } = rule;
  if (
    !Array.isArray(patterns) ||
    !patterns.every((p) => typeof p === "string")
  ) {
    console.error(
      "merge rule patterns are not a list of strings; it covers nothing:",
      name
    );
    return { logins, teams, matches: null, coversAll: false };
  }
  try {
    return {
      logins,
      teams,
      matches: compilePatterns(patterns),
      coversAll:
        patterns.some((p) => p === "*" || p === "**") &&
        !patterns.some((p) => p.startsWith("-")),
    };
  } catch (e) {
    console.error(
      "merge rule has an invalid pattern; it covers nothing:",
      name,
      e
    );
    return { logins, teams, matches: null, coversAll: false };
  }
}

export function parseMergeRules(text: string): MergeRule[] {
  const rules = yaml.load(text);
  if (!Array.isArray(rules)) {
    throw new Error(`${MERGE_RULES_FILE.path} must be a list of rules`);
  }
  return rules.map((rule) => parseRule(rule));
}

async function fetchMergeRules(octokit: Octokit): Promise<MergeRule[]> {
  const { data } = await octokit.rest.repos.getContent(MERGE_RULES_FILE);
  if (!("content" in data)) {
    throw new Error(`${MERGE_RULES_FILE.path}: unexpected response format`);
  }
  return parseMergeRules(Buffer.from(data.content, "base64").toString("utf-8"));
}

async function fetchTeamMembership(
  octokit: Octokit,
  team: string,
  login: string
): Promise<boolean> {
  const [org, teamSlug] = team.split("/");
  try {
    const { data } = await octokit.rest.teams.getMembershipForUserInOrg({
      org,
      team_slug: teamSlug,
      username: login,
    });
    return data.state === "active";
  } catch (e) {
    // GitHub's answer for a login that is not on the team.
    if ((e as any)?.status === 404) {
      return false;
    }
    throw e;
  }
}

// One gate per Dr.CI sweep or webhook event: the merge rules are fetched at most
// once, on first need, and team lookups are memoized. The returned check rejects
// on any GitHub or parse error rather than guessing.
export function greenlightEligibilityGate(
  octokit: Octokit,
  owner: string,
  repo: string
): EligibilityCheck {
  let mergeRules: Promise<MergeRule[]> | undefined;
  const memberships = new Map<string, Promise<boolean>>();

  function isTeamMember(team: string, login: string): Promise<boolean> {
    const key = `${team}:${login}`;
    let membership = memberships.get(key);
    if (membership === undefined) {
      membership = fetchTeamMembership(octokit, team, login);
      memberships.set(key, membership);
    }
    return membership;
  }

  async function namesAuthor(rules: MergeRule[], login: string) {
    for (const rule of rules) {
      if (rule.logins.includes(login)) {
        return true;
      }
      for (const team of rule.teams) {
        if (await isTeamMember(team, login)) {
          return true;
        }
      }
    }
    return false;
  }

  // merge_authz.py's approver union: every rule counts whatever its patterns, a
  // plain entry matches case-insensitively, and namesAuthor adds team members.
  async function isMergeApprover(rules: MergeRule[], login: string) {
    const lowered = login.toLowerCase();
    return (
      rules.some((rule) =>
        rule.logins.some((entry) => pyStrip(entry).toLowerCase() === lowered)
      ) || namesAuthor(rules, login)
    );
  }

  // The scan skips a PR a human has decided and writes no row for it, so
  // "waiting" would last for as long as that decision stands.
  async function waitingUnlessDecided(pr: EligibilityPr, rules: MergeRule[]) {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });
    const decided = await isHumanDecided(reviews, (reviewer) =>
      isMergeApprover(rules, reviewer)
    );
    return decided ? null : "waiting";
  }

  return async (pr) => {
    const login = pr.user?.login;
    if (pr.draft || !login) {
      return null;
    }
    // The scan lists only cohort.evaluation_cohort's PRs: merge-rule approvers
    // other than bots and greenlight.
    if (
      isBot(login, undefined) ||
      login.toLowerCase() === GREENLIGHT_APP_SLUG
    ) {
      return null;
    }
    mergeRules ??= fetchMergeRules(octokit);
    const rules = await mergeRules;
    if (!(await isMergeApprover(rules, login))) {
      return null;
    }
    if (
      pr.additions + pr.deletions > MAX_DIFF_LINES ||
      pr.changed_files > MAX_DIFF_FILES
    ) {
      return "too_big";
    }
    const catchAll = rules.filter((rule) => rule.coversAll);
    if (await namesAuthor(catchAll, login)) {
      return waitingUnlessDecided(pr, rules);
    }
    // A ghstack head lands by cherry-picking its orig branch, and a PR on another
    // base is listed against that base, so neither listing bounds what lands.
    if (
      GHSTACK_HEAD_REF_RE.test(pr.head.ref) ||
      pr.base.ref !== TARGET_BRANCH
    ) {
      return "merge_rules";
    }
    const files = await getFilesChangedByPr(octokit, owner, repo, pr.number);
    const covering = rules.filter(
      (rule) => rule.matches !== null && files.every(rule.matches)
    );
    return (await namesAuthor(covering, login))
      ? waitingUnlessDecided(pr, rules)
      : "merge_rules";
  };
}

export function renderGreenlightEligibility(
  eligibility: GreenlightEligibility | null
): string {
  if (eligibility === null) {
    return "";
  }
  return `\n${ELIGIBILITY_LAMP[eligibility]} <b>GreenLight</b>: ${ELIGIBILITY_STATUS[eligibility]}`;
}
