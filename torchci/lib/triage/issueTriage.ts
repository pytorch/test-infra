// Shared definitions for /triage/modules, the module-level issue triage page.
// The maintainer guide asks for every issue to be fully triaged within 7 days
// of creation: closed, or labelled with one of STATE_LABELS. The SQL side of
// these definitions lives in clickhouse_queries/issue_triage_*.

import dayjs from "dayjs";
import type { LabelTree } from "./labelTree";

export const REPO = "pytorch/pytorch";

export const STATE_LABELS = [
  "needs reproduction",
  "needs research",
  "needs design",
  "actionable",
  "won't fix",
];

// The issue and PR workflow was documented on this date (pytorch/pytorch#198527).
export const ROLLOUT_DATE = "2026-10-02";
// First day of label-event history in ClickHouse. Before it, the time an issue
// was fully triaged is unknown, so SLA numbers are not exact.
export const HISTORY_START_DATE = "2025-04-03";
// What "All" sends to the queries: earlier than any issue.
export const ALL_START_DATE = "1970-01-01";

export const SLA_DAYS = 7;
// "% triaged within 7 days" colour bands.
export const SLA_GOOD_PCT = 80;
export const SLA_WARN_PCT = 50;

export type StartPreset = "rollout" | "30d" | "90d" | "all" | "custom";

export const START_PRESETS: { value: StartPreset; label: string }[] = [
  { value: "rollout", label: `Workflow rollout (${ROLLOUT_DATE})` },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom date" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The `start` URL parameter is a preset name or a YYYY-MM-DD date.
export function parseStart(start: string | undefined): {
  preset: StartPreset;
  date: string;
} {
  if (start === undefined || start === "" || start === "rollout") {
    return { preset: "rollout", date: ROLLOUT_DATE };
  }
  if (start === "all") {
    return { preset: "all", date: ALL_START_DATE };
  }
  if (start === "30d" || start === "90d") {
    const days = start === "30d" ? 30 : 90;
    return {
      preset: start,
      date: dayjs().subtract(days, "day").format("YYYY-MM-DD"),
    };
  }
  // dayjs rolls 2026-13-45 over into a valid date, so require a round trip.
  if (DATE_RE.test(start) && dayjs(start).format("YYYY-MM-DD") === start) {
    return { preset: "custom", date: start };
  }
  return { preset: "rollout", date: ROLLOUT_DATE };
}

// Issues created before label-event history make the SLA numbers lower bounds.
export function isBeforeHistory(startDate: string): boolean {
  return startDate < HISTORY_START_DATE;
}

// The `label` URL parameter, repeated once per selected label. Order is kept,
// duplicates and blanks dropped.
export function parseLabels(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(new Set(values.map((v) => v.trim()).filter((v) => v)));
}

// GitHub search for the queue of one or more labels: open issues with any of
// `labels`, none of `excludeLabels` and none of the state labels, optionally
// limited to issues created on or after a date. `label:"a","b"` is GitHub's OR
// of labels; no module:/oncall: label contains a comma.
export function githubQueueUrl(
  labels: string[],
  startDate?: string,
  excludeLabels: string[] = []
): string {
  const terms = [
    `repo:${REPO}`,
    "is:issue",
    "is:open",
    `label:${labels.map((l) => `"${l}"`).join(",")}`,
    ...[...excludeLabels, ...STATE_LABELS].map((l) => `-label:"${l}"`),
  ];
  if (startDate !== undefined && startDate !== ALL_START_DATE) {
    terms.push(`created:>=${startDate}`);
  }
  return `https://github.com/${REPO}/issues?q=${encodeURIComponent(
    terms.join(" ")
  )}`;
}

// GitHub queue of a selection of labels. Automation adds parent labels to
// issues, so a parent's queue only needs the parent label. Without children,
// every label below a selected parent is excluded, except labels that are
// themselves selected.
export function githubSelectionUrl(
  selected: string[],
  includeChildren: boolean,
  tree: LabelTree,
  startDate?: string
): string {
  const excluded = includeChildren
    ? []
    : Array.from(new Set(selected.flatMap((l) => tree.descendants(l))))
        .filter((l) => !selected.includes(l))
        .sort();
  return githubQueueUrl(selected, startDate, excluded);
}

export type SlaLevel = "good" | "warn" | "bad" | "none";

export function slaPct(metSla: number, eligible: number): number | null {
  return eligible > 0 ? (100 * metSla) / eligible : null;
}

export function slaLevel(pct: number | null): SlaLevel {
  if (pct === null) {
    return "none";
  }
  if (pct >= SLA_GOOD_PCT) {
    return "good";
  }
  return pct >= SLA_WARN_PCT ? "warn" : "bad";
}

export function formatPct(pct: number | null): string {
  return pct === null ? "–" : `${Math.round(pct)}%`;
}

export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined || Number.isNaN(days)) {
    return "–";
  }
  return days < 10 ? days.toFixed(1) : Math.round(days).toString();
}

// Issues per outcome: the state label they carry, or closed without one.
export type OutcomeCounts = {
  actionable: number;
  needs_reproduction: number;
  needs_research: number;
  needs_design: number;
  wont_fix: number;
  closed: number;
};

export type LabelRow = OutcomeCounts & {
  label: string;
  // 1: counting the label's child labels too; 0: the label alone.
  include_children: number;
  queue_size: number;
  overdue: number;
  oldest_days: number;
  high_pri_in_queue: number;
  issues_created: number;
  sla_eligible: number;
  met_sla: number;
  median_days_to_triage: number | null;
};

export type OverviewRow = OutcomeCounts & {
  issues_created: number;
  sla_eligible: number;
  met_sla: number;
  median_days_to_triage: number | null;
  queue_size: number;
  overdue: number;
  no_queue: number;
  triage_review: number;
};

export type IssueRow = {
  number: number;
  title: string;
  html_url: string;
  created: string;
  age_days: number;
  in_queue: number;
  overdue: number;
  reopened: number;
  high_priority: number;
  // Every module:/oncall: label on the issue, selected or not.
  tracked_labels: string[];
  assignees: string[];
  outcome: string;
  triaged_at: string | null;
  days_to_triage: number | null;
};

// Each issue created that week is in exactly one of the four counts.
export type WeeklyRow = {
  week: string;
  issues_created: number;
  in_sla: number;
  out_of_sla_triaged: number;
  out_of_sla_untriaged: number;
  in_window: number;
};

// Outcome segments, in display order, for the table's stacked bar.
export const OUTCOMES: { key: keyof OutcomeCounts; label: string }[] = [
  { key: "actionable", label: "actionable" },
  { key: "needs_reproduction", label: "needs reproduction" },
  { key: "needs_research", label: "needs research" },
  { key: "needs_design", label: "needs design" },
  { key: "wont_fix", label: "won't fix" },
  { key: "closed", label: "closed" },
];
