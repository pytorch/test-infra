import fs from "fs";
import path from "path";

import {
  groupLevelAuditEvents,
  isSafeHttpUrl,
  LevelAuditEvent,
  parseCriteriaSnapshot,
} from "lib/crcr/levelAudit";

const query = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_level_audit",
    "query.sql"
  ),
  "utf8"
);

function event(overrides: Partial<LevelAuditEvent> = {}): LevelAuditEvent {
  return {
    event_id: "00000000-0000-0000-0000-000000000001",
    decision_id: "10000000-0000-0000-0000-000000000001",
    downstream_repo: "vendor/backend",
    previous_level: "L2",
    new_level: "L3",
    decision_kind: "promotion",
    decision_source: "automation",
    event_state: "proposed",
    evaluation_window_start: "2026-10-01 00:00:00",
    evaluation_window_end: "2026-10-15 00:00:00",
    criteria_snapshot_json: "",
    reason: "All promotion criteria qualified.",
    proposal_pr_url: "https://github.com/pytorch/pytorch/pull/1",
    approval_pr_url: "",
    configuration_commit_sha: "",
    configuration_commit_url: "",
    decision_actor: "crcr-promotion-bot",
    recorded_by: "crcr-promotion-bot",
    recorded_at: "2026-10-15 01:00:00",
    effective_at: null,
    criteria_schema_version: 1,
    ...overrides,
  };
}

describe("crcr_level_audit", () => {
  test("returns every lifecycle event for the latest decisions", () => {
    expect(query).toContain("recent_decisions AS");
    expect(query).toContain("GROUP BY decision_id");
    expect(query).toContain(
      "downstream_repo = {repo: String}"
    );
    expect(query).toContain("ORDER BY recorded_at DESC, event_id DESC");
    expect(query).toContain("LIMIT 1 BY event_id");
  });

  test("keeps proposal context after the applied lifecycle event arrives", () => {
    const proposed = event();
    const applied = event({
      event_id: "00000000-0000-0000-0000-000000000002",
      event_state: "applied",
      reason: "",
      recorded_at: "2026-10-16 01:00:00",
      effective_at: "2026-10-16 01:00:00",
      configuration_commit_sha: "a1b2c3d4e5f6",
      configuration_commit_url:
        "https://github.com/pytorch/pytorch/commit/a1b2c3d4e5f6",
    });

    const decisions = groupLevelAuditEvents([applied, proposed]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].current).toBe(applied);
    expect(decisions[0].events).toEqual([proposed, applied]);
  });

  test("orders same-time lifecycle events and ignores duplicate event IDs", () => {
    const proposed = event({
      event_id: "00000000-0000-0000-0000-000000000099",
      recorded_at: "2026-10-15 01:00:00.000",
    });
    const applied = event({
      event_id: "00000000-0000-0000-0000-000000000001",
      event_state: "applied",
      recorded_at: "2026-10-15 01:00:00.000",
      effective_at: "2026-10-15 01:00:00.000",
    });

    const decisions = groupLevelAuditEvents([proposed, applied, applied]);

    expect(decisions[0].current).toBe(applied);
    expect(decisions[0].events).toEqual([proposed, applied]);
  });

  test("does not let an unparsable timestamp supersede a known event", () => {
    const proposed = event();
    const malformed = event({
      event_id: "00000000-0000-0000-0000-000000000002",
      event_state: "superseded",
      recorded_at: "not a timestamp",
    });

    const decisions = groupLevelAuditEvents([malformed, proposed]);

    expect(decisions[0].current).toBe(proposed);
  });

  test("parses the version-one criterion snapshot contract", () => {
    expect(
      parseCriteriaSnapshot(
        JSON.stringify({
          criteria: [
            {
              name: "Job Pass Rate",
              target: "≥ 90%",
              observed: "97.2%",
              verdict: "met",
            },
          ],
        }),
        1
      )
    ).toEqual([
      {
        name: "Job Pass Rate",
        target: "≥ 90%",
        observed: "97.2%",
        verdict: "met",
      },
    ]);
    expect(parseCriteriaSnapshot('{"criteria":[]}', 2)).toBeNull();
    expect(parseCriteriaSnapshot('{"criteria":[{}]}', 1)).toBeNull();
  });

  test("only renders plain external http(s) record links", () => {
    expect(isSafeHttpUrl("https://github.com/pytorch/pytorch/pull/1")).toBe(
      true
    );
    expect(isSafeHttpUrl("https://github.com@evil.example/pull/1")).toBe(false);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
  });
});
