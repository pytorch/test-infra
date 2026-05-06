import * as yaml from "js-yaml";
import { minimatch } from "minimatch";
import { Context, Probot } from "probot";
import { getFilesChangedByPr, isPyTorchPyTorch } from "./utils";

// Implements logic similar to https://github.com/ethanis/nitpicker.
// Reads `.github/nitpick.yml` from the repo's default branch and posts
// (or updates) a single sticky comment on PRs whose changed files match
// any of the configured rules.
//
// Config format (top-level YAML list):
//
//   - markdown: |
//       ## Did you update the migration?
//       Reminder text shown to the PR author.
//     pathFilter:
//       - "+migrations/**"
//       - "-migrations/test/**"
//
// Each pattern is evaluated with `minimatch`. A pattern beginning with `+`
// (or with no prefix) is an include pattern; a pattern beginning with `-`
// is an exclude pattern. A file matches the rule if it matches any include
// pattern and no exclude pattern. The rule fires (its `markdown` is added
// to the comment) when at least one changed file matches.

export const NITPICK_COMMENT_START = "<!-- nitpick-bot-start -->";
export const NITPICK_COMMENT_END = "<!-- nitpick-bot-end -->";
export const NITPICK_CONFIG_PATH = ".github/nitpick.yml";

export interface NitpickRule {
  markdown: string;
  pathFilter: string[];
}

export function parseNitpickConfig(text: string): NitpickRule[] {
  const parsed = yaml.load(text);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const rules: NitpickRule[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry.markdown === "string" &&
      Array.isArray(entry.pathFilter)
    ) {
      rules.push({
        markdown: entry.markdown,
        pathFilter: entry.pathFilter.filter((p: any) => typeof p === "string"),
      });
    }
  }
  return rules;
}

export function fileMatchesRule(file: string, rule: NitpickRule): boolean {
  let included = false;
  for (const pat of rule.pathFilter) {
    if (pat.startsWith("-")) {
      if (minimatch(file, pat.slice(1))) {
        return false;
      }
    } else {
      const glob = pat.startsWith("+") ? pat.slice(1) : pat;
      if (minimatch(file, glob)) {
        included = true;
      }
    }
  }
  return included;
}

export function getMatchingRules(
  files: string[],
  rules: NitpickRule[]
): NitpickRule[] {
  return rules.filter((rule) =>
    files.some((file) => fileMatchesRule(file, rule))
  );
}

export function formNitpickComment(rules: NitpickRule[]): string {
  if (rules.length === 0) {
    return "";
  }
  const body = rules.map((r) => r.markdown.trim()).join("\n\n---\n\n");
  return `${NITPICK_COMMENT_START}\n${body}\n${NITPICK_COMMENT_END}`;
}

async function findExistingNitpickComment(
  context: Context<"pull_request">,
  owner: string,
  repo: string,
  prNum: number
): Promise<{ id: number; body: string }> {
  const res = await context.octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNum,
  });
  for (const c of res.data) {
    if (c.body && c.body.includes(NITPICK_COMMENT_START)) {
      return { id: c.id, body: c.body };
    }
  }
  return { id: 0, body: "" };
}

async function loadNitpickConfig(
  context: Context<"pull_request">,
  owner: string,
  repo: string
): Promise<NitpickRule[] | null> {
  try {
    const res = await context.octokit.repos.getContent({
      owner,
      repo,
      path: NITPICK_CONFIG_PATH,
    });
    const data = res.data as { content?: string; encoding?: string };
    if (!data.content) {
      return null;
    }
    const text = Buffer.from(
      data.content,
      (data.encoding as BufferEncoding) ?? "base64"
    ).toString("utf8");
    return parseNitpickConfig(text);
  } catch (err: any) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

export default function nitpickBot(app: Probot): void {
  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
    ],
    async (context) => {
      const owner = context.payload.repository.owner.login;
      const repo = context.payload.repository.name;
      // Limit to pytorch/pytorch initially.
      if (!isPyTorchPyTorch(owner, repo)) {
        context.log(
          `${__filename} only runs on pytorch/pytorch (got ${owner}/${repo})`
        );
        return;
      }
      if (context.payload.pull_request.state !== "open") {
        return;
      }
      const prNum = context.payload.pull_request.number;

      const rules = await loadNitpickConfig(context, owner, repo);
      if (rules == null) {
        context.log(`${NITPICK_CONFIG_PATH} not found, skipping`);
        return;
      }

      const filesChanged = await getFilesChangedByPr(
        context.octokit,
        owner,
        repo,
        prNum
      );
      const matched = getMatchingRules(filesChanged, rules);
      const newBody = formNitpickComment(matched);
      const existing = await findExistingNitpickComment(
        context,
        owner,
        repo,
        prNum
      );

      if (newBody === "") {
        if (existing.id !== 0) {
          await context.octokit.issues.deleteComment({
            owner,
            repo,
            comment_id: existing.id,
          });
        }
        return;
      }

      if (existing.id === 0) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNum,
          body: newBody,
        });
      } else if (existing.body !== newBody) {
        await context.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: existing.id,
          body: newBody,
        });
      }
    }
  );
}
