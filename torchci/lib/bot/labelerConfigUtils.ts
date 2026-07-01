import { minimatch } from "minimatch";
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

export async function getLabelsFromLabelerConfig(
  context: Context,
  labelerConfigTracker: CachedLabelerConfigTracker,
  changed_files: string[],
  isDraft: boolean = false
): Promise<string[]> {
  const config = await labelerConfigTracker.loadLabelsConfig(context);
  const labels: string[] = [];

  for (const [label, rawRule] of Object.entries(config)) {
    const rule = normalizeLabelerRule(rawRule);
    if (rule === null) {
      const skipReason = labelerRuleSkipReason(rawRule);
      if (skipReason === "invalid_draft") {
        context.log(
          {
            label,
            rawRule,
            draft: (rawRule as { draft?: unknown }).draft,
          },
          "getLabelsFromLabelerConfig: invalid draft type (expected boolean), skipping"
        );
      } else {
        context.log(
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
