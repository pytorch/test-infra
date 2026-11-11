import yaml from "js-yaml";
import type { ReleaseConfig } from "lib/api/releases/types";
import { RELEASE_TYPES, TIERS } from "lib/api/releases/types";
import { z } from "zod/v4";

// The release config is the YAML in release/portal/config of pytorch/test-infra: the
// steps every release shares (steps.yml) and a file per release (releases/<version>.yml).
// The collector resolves it in Python (tools/torchci/release_portal_config.py); this
// module resolves it again, in TypeScript, by the same rules, from the files on `main`,
// so a change merged there shows without a deploy. A test resolves the committed files
// and checks the parts both implementations must agree on.

export const CONFIG_BASE_URL =
  "https://raw.githubusercontent.com/pytorch/test-infra/main/release/portal/config";
export const CONFIG_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; text: string | null }>();

export function clearConfigCache(): void {
  cache.clear();
}

// The file's text, or null when it does not exist. A file is kept for CONFIG_TTL_MS; when
// GitHub cannot be reached, the last copy is used however old it is.
async function fetchConfigText(path: string): Promise<string | null> {
  const url = `${CONFIG_BASE_URL}/${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.text;
  try {
    const response = await fetch(url);
    if (response.status === 404) {
      cache.set(url, { at: Date.now(), text: null });
      return null;
    }
    if (!response.ok) {
      throw new Error(`fetching ${url} answered ${response.status}`);
    }
    const text = await response.text();
    cache.set(url, { at: Date.now(), text });
    return text;
  } catch (error) {
    if (hit) {
      console.warn(`using the stale copy of ${url}:`, error);
      return hit.text;
    }
    throw error;
  }
}

const StepSchema = z.object({
  id: z.string(),
  phase: z.number().int(),
  name: z.string(),
  tier: z.enum(TIERS),
  owner: z.string(),
  rc_scoped: z.boolean().optional(),
  depends_on: z.array(z.string()).optional(),
  due: z
    .object({ anchor: z.string(), offset_days: z.number().int() })
    .optional(),
  runbook: z.record(z.string(), z.string()).optional(),
  types: z.array(z.enum(RELEASE_TYPES)).optional(),
  window: z
    .object({ opens: z.string().optional(), closes: z.string().optional() })
    .optional(),
  check: z.looseObject({ type: z.string() }),
});
type Step = z.infer<typeof StepSchema>;

const ResourceSchema = z.union([
  z.string(),
  z.object({ test: z.string(), release: z.string() }),
]);

const SharedSchema = z.object({
  version: z.number().int(),
  discovery: z.record(z.string(), z.unknown()),
  resources: z.record(z.string(), ResourceSchema),
  phases: z.array(z.object({ id: z.number().int(), name: z.string() })),
  steps: z.array(StepSchema),
});
export type SharedConfig = z.infer<typeof SharedSchema>;

const DateSchema = z.string().nullable().optional();
const ReleaseFileSchema = z.object({
  release: z.string(),
  type: z.enum(RELEASE_TYPES).optional(),
  branch: z.string().optional(),
  dates: z
    .object({
      branch_cut: DateSchema,
      final_rc: DateSchema,
      ga: DateSchema,
    })
    .optional(),
  links: z
    .object({
      milestone: z.union([z.string(), z.number()]).nullable().optional(),
      tracker_issue: z.union([z.string(), z.number()]).nullable().optional(),
      validation_issue: z.union([z.string(), z.number()]).nullable().optional(),
    })
    .optional(),
  remove: z.array(z.string()).optional(),
  override: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  add: z.array(StepSchema).optional(),
});
export type ReleaseFile = z.infer<typeof ReleaseFileSchema>;

// CORE_SCHEMA leaves 2026-11-30 a string; the default schema would make it a Date.
function parseYaml<T>(text: string, schema: z.ZodType<T>, what: string): T {
  const parsed = schema.safeParse(
    yaml.load(text, { schema: yaml.CORE_SCHEMA })
  );
  if (!parsed.success) {
    throw new Error(
      `${what} is not a valid release config: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

export function releaseType(version: string): "minor" | "patch" {
  return version.endsWith(".0") ? "minor" : "patch";
}

export function minorOf(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

// The shared steps with the release's changes applied: `remove`, then `override` (a
// field set to null is dropped), then `add`; then the steps that do not apply to the
// release's type are left out, and the dependencies on them are dropped.
export function resolveRelease(
  shared: SharedConfig,
  file: ReleaseFile | null,
  version: string
): ReleaseConfig {
  const type = file?.type ?? releaseType(version);
  const removed = new Set(file?.remove ?? []);
  const steps: Step[] = structuredClone(shared.steps).filter(
    (step) => !removed.has(step.id)
  );
  for (const step of steps) {
    for (const [key, value] of Object.entries(
      file?.override?.[step.id] ?? {}
    )) {
      const fields = step as Record<string, unknown>;
      if (value === null) delete fields[key];
      else fields[key] = value;
    }
  }
  steps.push(...structuredClone(file?.add ?? []));
  const applicable = steps.filter((step) =>
    (step.types ?? RELEASE_TYPES).includes(type)
  );
  const ids = new Set(applicable.map((step) => step.id));
  for (const step of applicable) {
    if (step.depends_on) {
      step.depends_on = step.depends_on.filter((id) => ids.has(id));
    }
  }
  return {
    version: shared.version,
    release: version,
    type,
    branch: file?.branch ?? `release/${minorOf(version)}`,
    dates: {
      branch_cut: file?.dates?.branch_cut ?? null,
      final_rc: file?.dates?.final_rc ?? null,
      ga: file?.dates?.ga ?? null,
    },
    links: {
      milestone: file?.links?.milestone ?? null,
      tracker_issue: file?.links?.tracker_issue ?? null,
      validation_issue: file?.links?.validation_issue ?? null,
    },
    discovery: shared.discovery,
    resources: shared.resources,
    phases: shared.phases,
    steps: applicable,
  };
}

export async function loadSharedConfig(): Promise<SharedConfig> {
  const text = await fetchConfigText("steps.yml");
  if (text === null)
    throw new Error("release/portal/config/steps.yml is missing");
  return parseYaml(text, SharedSchema, "steps.yml");
}

// A release's resolved config. A release without a file of its own is resolved from
// the shared steps alone (its type and branch follow from the version); `hasFile` says
// which it was.
export async function loadReleaseConfig(
  version: string,
  shared?: SharedConfig
): Promise<{ config: ReleaseConfig; hasFile: boolean }> {
  const base = shared ?? (await loadSharedConfig());
  const text = await fetchConfigText(`releases/${version}.yml`);
  const file =
    text === null
      ? null
      : parseYaml(text, ReleaseFileSchema, `releases/${version}.yml`);
  if (file !== null && file.release !== version) {
    throw new Error(`releases/${version}.yml is for release ${file.release}`);
  }
  return {
    config: resolveRelease(base, file, version),
    hasFile: file !== null,
  };
}

// A template with its {name} placeholders filled, or null when one has no value.
export function fillTemplate(
  template: string,
  values: Record<string, string | number | null | undefined>
): string | null {
  let missing = false;
  const filled = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === null || value === undefined) {
      missing = true;
      return "";
    }
    return String(value);
  });
  return missing ? null : filled;
}
