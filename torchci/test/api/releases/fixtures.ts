import { readFileSync } from "fs";
import type { SharedConfig } from "lib/api/releases/config";
import { resolveRelease } from "lib/api/releases/config";
import type { StepStateRow } from "lib/api/releases/state";
import { join } from "path";

// The committed config, as GitHub's raw host serves it, for the tests that load it.
export const CONFIG_DIR = join(
  process.cwd(),
  "..",
  "release",
  "portal",
  "config"
);

export function committedFile(path: string): string | null {
  try {
    return readFileSync(join(CONFIG_DIR, path), "utf8");
  } catch {
    return null;
  }
}

// A fetch that answers from the committed files; any other URL is a 404.
export function committedFetch(extra: Record<string, string | null> = {}) {
  return jest.fn(async (url: string) => {
    const path = String(url).replace(/^.*\/release\/portal\/config\//, "");
    const text = path in extra ? extra[path] : committedFile(path);
    return text === null
      ? new Response("not found", { status: 404 })
      : new Response(text, { status: 200 });
  });
}

export const DISCOVERY = {
  milestone: { repo: "pytorch/pytorch", title: "{version}" },
  tracker_issue: {
    repo: "pytorch/pytorch",
    query: 'label:"release tracker"',
    title_regex: "^\\[v\\.?{version}\\] Release Tracker$",
  },
  validation_issue: {
    repo: "pytorch/pytorch",
    query: "in:title validations",
    title_regex: {
      minor: "^Release ({minor}|{version}) validations",
      patch: "^Release {version} validations",
    },
  },
};

type StepInput = Partial<SharedConfig["steps"][number]> & { id: string };

export function step(input: StepInput): SharedConfig["steps"][number] {
  return {
    phase: Number(input.id.split(".")[0]),
    name: `Step ${input.id}`,
    tier: "M",
    owner: "release-manager",
    check: {
      type: "manual_link",
      what_to_check: "look",
      link: "https://x/{version}",
    },
    ...input,
  };
}

export const SHARED: SharedConfig = {
  version: 1,
  discovery: DISCOVERY,
  resources: {
    wheels: {
      test: "https://download.pytorch.org/whl/test/",
      release: "https://download.pytorch.org/whl/",
    },
    docs: "https://docs.pytorch.org/docs/{minor}/",
  },
  phases: [
    { id: 1, name: "Preparation" },
    { id: 2, name: "RC build" },
  ],
  steps: [
    step({
      id: "1.1",
      types: ["minor"],
      due: { anchor: "branch_cut", offset_days: -7 },
    }),
    step({
      id: "1.2",
      tier: "A",
      check: {
        type: "milestone_outstanding_items",
        repo: "pytorch/pytorch",
        milestone: "{milestone}",
        max_outstanding: 0,
      },
    }),
    step({
      id: "2.1",
      tier: "A",
      rc_scoped: true,
      depends_on: ["1.1", "1.2"],
      check: {
        type: "github_ref_exists",
        repos: ["pytorch/pytorch"],
        ref: "v{version}-{rc}",
        kind: "tag",
      },
    }),
    step({
      id: "2.2",
      check: {
        type: "manual_link",
        what_to_check: "tracker",
        link: "{tracker_issue_url}",
      },
    }),
  ],
};

export const MINOR = resolveRelease(
  SHARED,
  {
    release: "2.16.0",
    dates: {
      branch_cut: "2026-11-30",
      final_rc: "2026-12-07",
      ga: "2026-12-17",
    },
  },
  "2.16.0"
);

export function row(
  partial: Partial<StepStateRow> & { step_id: string }
): StepStateRow {
  return {
    release: "2.16.0",
    rc: "",
    status: "todo",
    blocking: 0,
    evidence_text: "",
    evidence_url: "",
    last_checked: "2026-12-01 10:00:00.000",
    ...partial,
  };
}
