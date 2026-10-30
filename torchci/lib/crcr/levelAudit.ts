import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcherHandleError } from "lib/GeneralUtils";
import useSWR from "swr";

dayjs.extend(utc);

export const AUDIT_DECISION_KINDS = [
  "promotion",
  "demotion",
  "initial",
] as const;
export const AUDIT_DECISION_SOURCES = [
  "automation",
  "maintainer",
  "onboarding",
] as const;
export const AUDIT_EVENT_STATES = [
  "proposed",
  "applied",
  "closed",
  "superseded",
] as const;

export type AuditDecisionKind = (typeof AUDIT_DECISION_KINDS)[number];
export type AuditDecisionSource = (typeof AUDIT_DECISION_SOURCES)[number];
export type AuditEventState = (typeof AUDIT_EVENT_STATES)[number];

export interface LevelAuditEvent {
  event_id: string;
  decision_id: string;
  downstream_repo: string;
  previous_level: string;
  new_level: string;
  decision_kind: string;
  decision_source: string;
  event_state: string;
  evaluation_window_start: string | null;
  evaluation_window_end: string | null;
  criteria_snapshot_json: string;
  reason: string;
  proposal_pr_url: string;
  approval_pr_url: string;
  configuration_commit_sha: string;
  configuration_commit_url: string;
  decision_actor: string;
  recorded_by: string;
  recorded_at: string;
  effective_at: string | null;
  criteria_schema_version: number;
}

export interface LevelAuditDecision {
  decision_id: string;
  current: LevelAuditEvent;
  events: LevelAuditEvent[];
}

export interface AuditCriterion {
  name: string;
  target: string;
  observed: string;
  verdict: "met" | "failed" | "not_applicable";
}

const EVENT_STATE_ORDER: Record<string, number> = {
  proposed: 0,
  applied: 1,
  closed: 1,
  superseded: 2,
};

function timestamp(event: LevelAuditEvent): number | undefined {
  const parsed = dayjs.utc(event.recorded_at);
  return parsed.isValid() ? parsed.valueOf() : undefined;
}

function eventComparator(a: LevelAuditEvent, b: LevelAuditEvent): number {
  const aTimestamp = timestamp(a);
  const bTimestamp = timestamp(b);
  if (aTimestamp !== undefined && bTimestamp !== undefined) {
    const difference = aTimestamp - bTimestamp;
    if (difference) return difference;
  } else if (aTimestamp !== undefined) {
    return 1;
  } else if (bTimestamp !== undefined) {
    return -1;
  }

  const stateDifference =
    (EVENT_STATE_ORDER[a.event_state] ?? -1) -
    (EVENT_STATE_ORDER[b.event_state] ?? -1);
  return stateDifference || a.event_id.localeCompare(b.event_id);
}

export function groupLevelAuditEvents(
  events: LevelAuditEvent[]
): LevelAuditDecision[] {
  const uniqueEvents = new Map<string, LevelAuditEvent>();
  for (const event of events) {
    const existing = uniqueEvents.get(event.event_id);
    if (!existing || eventComparator(existing, event) < 0) {
      uniqueEvents.set(event.event_id, event);
    }
  }

  const byDecision = new Map<string, LevelAuditEvent[]>();
  for (const event of uniqueEvents.values()) {
    const decisionEvents = byDecision.get(event.decision_id) ?? [];
    decisionEvents.push(event);
    byDecision.set(event.decision_id, decisionEvents);
  }

  return Array.from(byDecision, ([decision_id, decisionEvents]) => {
    const orderedEvents = [...decisionEvents].sort(eventComparator);
    return {
      decision_id,
      events: orderedEvents,
      current: orderedEvents[orderedEvents.length - 1],
    };
  }).sort((a, b) => eventComparator(b.current, a.current));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCriterion(value: unknown): value is AuditCriterion {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.target === "string" &&
    typeof value.observed === "string" &&
    ["met", "failed", "not_applicable"].includes(value.verdict as string)
  );
}

export function parseCriteriaSnapshot(
  snapshotJson: string,
  schemaVersion: number
): AuditCriterion[] | null {
  if (!snapshotJson || schemaVersion !== 1) return null;
  try {
    const snapshot: unknown = JSON.parse(snapshotJson);
    if (!isRecord(snapshot) || !Array.isArray(snapshot.criteria)) return null;
    return snapshot.criteria.every(isCriterion) ? snapshot.criteria : null;
  } catch {
    return null;
  }
}

export function firstAuditValue(
  decision: LevelAuditDecision,
  field: keyof LevelAuditEvent
): string | null {
  for (const event of [...decision.events].reverse()) {
    const value = event[field];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export function auditDisplayTime(event: LevelAuditEvent): string {
  return event.effective_at ?? event.recorded_at;
}

export function isSafeHttpUrl(value: string | null): value is string {
  if (!value || /[\s\x00-\x1f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

const LEVEL_AUDIT_LIMIT = 100;

export function useLevelAudit(repoFullName: string) {
  const url = repoFullName
    ? `/api/clickhouse/crcr_level_audit?parameters=${encodeURIComponent(
        JSON.stringify({ repo: repoFullName, limit: LEVEL_AUDIT_LIMIT })
      )}`
    : null;
  const { data, error } = useSWR<LevelAuditEvent[]>(url, fetcherHandleError);
  return {
    decisions: groupLevelAuditEvents(data ?? []),
    error,
    loaded: data !== undefined || !!error,
  };
}
