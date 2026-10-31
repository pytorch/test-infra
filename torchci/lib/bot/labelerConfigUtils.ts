import yaml from "js-yaml";
import { minimatch } from "minimatch";
import { Octokit } from "octokit";
import { Context } from "probot";
import { CachedLabelerConfigTracker } from "./utils";

/** Legacy rules are a list of path globs; extended rules add optional draft behavior. */
export type LabelerRule =
  | string[]
  | {
      globs: string[];
      /** false = skip label while PR is draft; true = only when draft; omit = always apply when globs match */
      draft?: boolean;
    };

export function labelerRuleSkipReason(
  rawRule: unknown
): "invalid_draft" | "invalid_shape" | null {
  if (
    rawRule !== null &&
    typeof rawRule === "object" &&
    "globs" in rawRule &&
    Array.isArray((rawRule as { globs: unknown }).globs) &&
    (rawRule as { globs: unknown[] }).globs.every((x) => typeof x === "string")
  ) {
    const r = rawRule as { globs: string[]; draft?: unknown };
    if ("draft" in r && typeof r.draft !== "boolean") {
      return "invalid_draft";
    }
  }
  return "invalid_shape";
}

export function normalizeLabelerRule(rule: unknown): LabelerRule | null {
  if (Array.isArray(rule) && rule.every((x) => typeof x === "string")) {
    return rule as string[];
  }
  if (
    rule !== null &&
    typeof rule === "object" &&
    "globs" in rule &&
    Array.isArray((rule as { globs: unknown }).globs) &&
    (rule as { globs: unknown[] }).globs.every((x) => typeof x === "string")
  ) {
    const r = rule as { globs: string[]; draft?: unknown };
    if ("draft" in r && typeof r.draft !== "boolean") {
      return null;
    }
    const out: { globs: string[]; draft?: boolean } = { globs: r.globs };
    if (typeof r.draft === "boolean") {
      out.draft = r.draft;
    }
    return out;
  }
  return null;
}

export function globsFromRule(rule: LabelerRule): string[] {
  return Array.isArray(rule) ? rule : rule.globs;
}

export function draftConstraintAllowsLabel(
  rule: LabelerRule,
  isDraft: boolean
): boolean {
  const draftOpt = Array.isArray(rule) ? undefined : rule.draft;
  if (draftOpt === undefined) {
    return true;
  }
  if (draftOpt === false) {
    return !isDraft;
  }
  return isDraft;
}

export type LabelerLog = (_fields: object, _message: string) => void;

/** The labels a PR with these changed files and draft state needs under a labeler config. */
export function getLabelsNeededByFiles(
  config: Record<string, unknown>,
  changed_files: string[],
  isDraft: boolean,
  log: LabelerLog = () => {}
): string[] {
  const labels: string[] = [];

  for (const [label, rawRule] of Object.entries(config)) {
    const rule = normalizeLabelerRule(rawRule);
    if (rule === null) {
      const skipReason = labelerRuleSkipReason(rawRule);
      if (skipReason === "invalid_draft") {
        log(
          {
            label,
            rawRule,
            draft: (rawRule as { draft?: unknown }).draft,
          },
          "getLabelsFromLabelerConfig: invalid draft type (expected boolean), skipping"
        );
      } else {
        log(
          { label, rawRule },
          "getLabelsFromLabelerConfig: unknown rule shape, skipping"
        );
      }
      continue;
    }
    if (!draftConstraintAllowsLabel(rule, isDraft)) {
      continue;
    }
    const globs = globsFromRule(rule);
    if (
      globs.some((glob: string) =>
        changed_files.some((file: string) => minimatch(file, glob))
      )
    ) {
      labels.push(label);
    }
  }
  return labels;
}

export async function getLabelsFromLabelerConfig(
  context: Context,
  labelerConfigTracker: CachedLabelerConfigTracker,
  changed_files: string[],
  isDraft: boolean = false
): Promise<string[]> {
  const config = await labelerConfigTracker.loadLabelsConfig(context);
  return getLabelsNeededByFiles(
    config as Record<string, unknown>,
    changed_files,
    isDraft,
    (fields, message) => context.log(fields, message)
  );
}

export function getDraftGatedLabelsToRemove(
  config: Record<string, unknown>,
  changed_files: string[],
  isDraft: boolean
): string[] {
  const toRemove: string[] = [];
  for (const [label, rawRule] of Object.entries(config)) {
    const rule = normalizeLabelerRule(rawRule);
    if (rule === null || Array.isArray(rule) || rule.draft === undefined) {
      continue;
    }
    const globsMatch = globsFromRule(rule).some((glob) =>
      changed_files.some((file) => minimatch(file, glob))
    );
    if (globsMatch && !draftConstraintAllowsLabel(rule, isDraft)) {
      toRemove.push(label);
    }
  }
  return toRemove;
}

async function readRepoYaml(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string
): Promise<unknown> {
  let data;
  try {
    data = (await octokit.rest.repos.getContent({ owner, repo, path })).data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return null;
    }
    throw error;
  }
  if (!("content" in data)) {
    throw new Error(`${owner}/${repo} ${path}: unexpected response format`);
  }
  return yaml.load(Buffer.from(data.content, "base64").toString("utf-8"));
}

/**
 * The labeler config named by `labeler_config` in .github/pytorch-probot.yml on
 * the repo's default branch, for callers outside probot. Null when the repo has
 * no labeler config.
 */
export async function loadLabelerConfig(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<Record<string, unknown> | null> {
  const probotConfig: any = await readRepoYaml(
    octokit,
    owner,
    repo,
    ".github/pytorch-probot.yml"
  );
  const labelerFile = probotConfig?.labeler_config;
  if (typeof labelerFile !== "string") {
    return null;
  }
  const labelerConfig = await readRepoYaml(
    octokit,
    owner,
    repo,
    `.github/${labelerFile}`
  );
  if (labelerConfig === null || typeof labelerConfig !== "object") {
    return null;
  }
  return labelerConfig as Record<string, unknown>;
}
