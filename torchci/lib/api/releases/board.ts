import { fillTemplate } from "lib/api/releases/config";
import { isoFromClickhouse, StepStateRow } from "lib/api/releases/state";
import type {
  ReleaseBoard,
  ReleaseConfig,
  ReleaseIndex,
  ReleaseStep,
} from "lib/api/releases/types";
import { hudOrigin } from "lib/api/tests/pages/links";

// What the portal shows of a release is computed here from two things: the release's
// resolved config (its steps) and the current state rows from release_event. No I/O.

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

type Status = ReleaseStep["status"];
type ConfigStep = ReleaseConfig["steps"][number];

const MILESTONES: [string, string][] = [
  ["branch_cut", "Branch cut"],
  ["final_rc", "Final RC"],
  ["ga", "GA"],
];

function rcNumber(rc: string): number {
  const match = /^rc(\d+)$/.exec(rc);
  return match ? Number(match[1]) : -1;
}

// The newest release candidate any step has a state for, or null.
export function currentRc(rows: StepStateRow[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (row.rc === "") continue;
    if (newest === null || rcNumber(row.rc) > rcNumber(newest)) newest = row.rc;
  }
  return newest;
}

function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

function dueDate(config: ReleaseConfig, step: ConfigStep): string | null {
  if (!step.due) return null;
  const date = config.dates[step.due.anchor];
  return date ? addDays(date, step.due.offset_days) : null;
}

export function nextMilestone(
  config: ReleaseConfig,
  now: Date
): { name: string; date: string } | null {
  const today = now.toISOString().slice(0, 10);
  const upcoming = MILESTONES.flatMap(([key, name]) => {
    const date = config.dates[key];
    return date && date >= today ? [{ name, date }] : [];
  });
  upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return upcoming[0] ?? null;
}

interface StepView extends ReleaseStep {
  phase: number;
}

const STATUSES: Status[] = ["done", "blocked", "in_progress", "todo"];
const NO_LINKS: DiscoveredLinks = {
  milestone: null,
  tracker_issue: null,
  validation_issue: null,
};

function rowsByKey(rows: StepStateRow[]): Map<string, StepStateRow> {
  return new Map(rows.map((row) => [`${row.step_id}\u0000${row.rc}`, row]));
}

// The release's milestone, tracker issue and validation issue, as the collector recorded
// them: the evidence of the step that checks it links to it. The steps are found by what
// they check, not by id (a milestone_outstanding_items step checks "{milestone}", a
// github_issue_state step checks "{tracker_issue}"), and only a link of the right shape
// counts, so a step whose evidence links elsewhere is passed over. Nothing is asked of
// GitHub: a link the collector has not recorded yet is null.
const GITHUB_PYTORCH = "https://github\\.com/pytorch/pytorch";
const LINK_SOURCES: {
  link: keyof DiscoveredLinks;
  field: string;
  placeholder: string;
  url: RegExp;
}[] = [
  {
    link: "milestone",
    field: "milestone",
    placeholder: "{milestone}",
    url: new RegExp(`^${GITHUB_PYTORCH}/milestone/(\\d+)$`),
  },
  {
    link: "tracker_issue",
    field: "issue",
    placeholder: "{tracker_issue}",
    url: new RegExp(`^${GITHUB_PYTORCH}/issues/(\\d+)$`),
  },
  {
    link: "validation_issue",
    field: "issue",
    placeholder: "{validation_issue}",
    url: new RegExp(`^${GITHUB_PYTORCH}/issues/(\\d+)$`),
  },
];

export function linksFromRows(
  config: ReleaseConfig,
  rows: StepStateRow[]
): DiscoveredLinks {
  const rc = currentRc(rows);
  const byKey = rowsByKey(rows);
  const links: DiscoveredLinks = { ...NO_LINKS };
  for (const source of LINK_SOURCES) {
    for (const step of config.steps) {
      const check = step.check as Record<string, unknown>;
      if (check[source.field] !== source.placeholder) continue;
      const row = byKey.get(
        `${step.id}\u0000${step.rc_scoped ? rc ?? "" : ""}`
      );
      const match = source.url.exec(row?.evidence_url ?? "");
      if (match) {
        links[source.link] = {
          number: Number(match[1]),
          title: "",
          url: match[0],
        };
        break;
      }
    }
  }
  return links;
}

function stepViews(
  config: ReleaseConfig,
  rows: StepStateRow[],
  links: DiscoveredLinks
): { views: StepView[]; rc: string | null } {
  const rc = currentRc(rows);
  const byKey = rowsByKey(rows);
  const linkValues = {
    version: config.release,
    minor: config.release.split(".").slice(0, 2).join("."),
    branch: config.branch,
    rc,
    tracker_issue: links.tracker_issue?.number ?? null,
    validation_issue: links.validation_issue?.number ?? null,
    milestone: links.milestone?.number ?? null,
    tracker_issue_url: links.tracker_issue?.url ?? null,
    validation_issue_url: links.validation_issue?.url ?? null,
  };
  const views = config.steps.map((step): StepView => {
    const scopedRc = step.rc_scoped ? rc : null;
    const row = byKey.get(`${step.id}\u0000${scopedRc ?? ""}`);
    const status = STATUSES.find((s) => s === row?.status) ?? "todo";
    const check = step.check as Record<string, unknown>;
    return {
      phase: step.phase,
      id: step.id,
      name: step.name,
      tier: step.tier,
      owner: step.owner,
      rc: scopedRc,
      status,
      // a step that is done blocks nothing, whatever an old row said
      blocking: status !== "done" && Number(row?.blocking ?? 0) === 1,
      depends_on: step.depends_on ?? [],
      due: dueDate(config, step),
      runbook: step.runbook ?? null,
      evidence: row
        ? { text: row.evidence_text, url: row.evidence_url || null }
        : null,
      manual:
        check.type === "manual_link"
          ? {
              what_to_check: String(check.what_to_check ?? ""),
              link: fillTemplate(String(check.link ?? ""), {
                ...linkValues,
                rc: scopedRc,
              }),
            }
          : null,
      last_checked: row ? isoFromClickhouse(row.last_checked) : null,
    };
  });
  return { views, rc };
}

function releaseStatus(views: StepView[]): Status {
  if (views.length > 0 && views.every((v) => v.status === "done"))
    return "done";
  if (views.some((v) => v.blocking)) return "blocked";
  if (views.some((v) => v.status === "in_progress" || v.status === "done")) {
    return "in_progress";
  }
  return "todo";
}

function currentPhase(config: ReleaseConfig, views: StepView[]): string {
  const open = config.phases.find((phase) =>
    views.some((v) => v.phase === phase.id && v.status !== "done")
  );
  return open?.name ?? "Released";
}

// What the release file sets by hand wins over what the rows say: a number names the
// issue or milestone, a URL is used as it is; any other value is ignored.
function chosen(
  override: string | number | null | undefined,
  numberedUrl: (_n: number) => string,
  found: FoundObject | null
): FoundObject | null {
  if (typeof override === "number") {
    return { number: override, title: "", url: numberedUrl(override) };
  }
  if (typeof override === "string" && override.startsWith("https://")) {
    return {
      number: Number(override.split("/").pop()) || 0,
      title: "",
      url: override,
    };
  }
  return found;
}

export function effectiveLinks(
  config: ReleaseConfig,
  found: DiscoveredLinks
): DiscoveredLinks {
  const issue = (n: number) => `https://github.com/pytorch/pytorch/issues/${n}`;
  const milestone = (n: number) =>
    `https://github.com/pytorch/pytorch/milestone/${n}`;
  return {
    milestone: chosen(config.links.milestone, milestone, found.milestone),
    tracker_issue: chosen(
      config.links.tracker_issue,
      issue,
      found.tracker_issue
    ),
    validation_issue: chosen(
      config.links.validation_issue,
      issue,
      found.validation_issue
    ),
  };
}

function resourceLinks(
  config: ReleaseConfig,
  done: boolean
): Record<string, string | null> {
  const values = {
    version: config.release,
    minor: config.release.split(".").slice(0, 2).join("."),
    branch: config.branch,
  };
  return Object.fromEntries(
    Object.entries(config.resources).map(([name, resource]) => {
      const template =
        typeof resource === "string"
          ? resource
          : ((resource as { test: string; release: string })[
              done ? "release" : "test"
            ] as string);
      return [name, fillTemplate(template, values)];
    })
  );
}

export function buildBoard(
  config: ReleaseConfig,
  rows: StepStateRow[],
  now: Date
): ReleaseBoard {
  const found = effectiveLinks(config, linksFromRows(config, rows));
  const { views, rc } = stepViews(config, rows, found);
  const checked = views.flatMap((v) =>
    v.last_checked ? [v.last_checked] : []
  );
  const done = views.filter((v) => v.status === "done").length;
  const out = releaseStatus(views) === "done";
  return {
    version: config.release,
    type: config.type,
    branch: config.branch,
    current_rc: rc,
    links: {
      tracker_issue: found.tracker_issue?.url ?? null,
      validation_issue: found.validation_issue?.url ?? null,
      milestone: found.milestone?.url ?? null,
      ...resourceLinks(config, out),
      // absolute, like the tests API's hud_url, so a program can hand it on as it is
      artifacts: `${hudOrigin()}/release/${config.release}/artifacts`,
    },
    stats: {
      done,
      total: views.length,
      blocking: views.filter((v) => v.blocking).length,
      next_milestone: nextMilestone(config, now),
      last_checked: checked.length
        ? checked.reduce((a, b) => (b > a ? b : a))
        : null,
    },
    phases: config.phases.map((phase) => {
      const steps = views
        .filter((v) => v.phase === phase.id)
        .map(({ phase: _phase, ...step }) => step);
      return {
        id: phase.id,
        name: phase.name,
        collapsed: steps.length > 0 && steps.every((s) => s.status === "done"),
        steps,
      };
    }),
  };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function buildIndex(
  releases: { config: ReleaseConfig; rows: StepStateRow[] }[],
  now: Date
): ReleaseIndex {
  const entries = releases
    .map(({ config, rows }) => {
      const { views } = stepViews(config, rows, NO_LINKS);
      return {
        config,
        views,
        status: releaseStatus(views),
        phase: currentPhase(config, views),
      };
    })
    .sort((a, b) => compareVersions(b.config.release, a.config.release));
  return {
    active: entries
      .filter((e) => e.status !== "done")
      .map((e) => ({
        version: e.config.release,
        phase: e.phase,
        blocking: e.views.filter((v) => v.blocking).length,
        next_milestone: nextMilestone(e.config, now),
      })),
    releases: entries.map((e) => ({
      version: e.config.release,
      type: e.config.type,
      branch: e.config.branch,
      ga_date: e.config.dates.ga ?? null,
      ga_planned: e.status !== "done",
      progress: {
        done: e.views.filter((v) => v.status === "done").length,
        total: e.views.length,
      },
      phase: e.phase,
      status: e.status,
    })),
    pagination: { next: null, previous: null },
  };
}
