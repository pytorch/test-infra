import CrcrLevelAudit from "components/crcr/CrcrLevelAudit";
import { useLevelAudit } from "lib/crcr/levelAudit";
import { useLevelHistory } from "lib/crcr/levelHistory";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("lib/crcr/levelAudit", () => {
  const actual = jest.requireActual("lib/crcr/levelAudit");
  return { ...actual, useLevelAudit: jest.fn() };
});

jest.mock("lib/crcr/levelHistory", () => ({
  useLevelHistory: jest.fn(),
}));

jest.mock("components/common/TimeUtils", () => ({
  LocalTimeHuman: ({ timestamp }: { timestamp: string }) => <>{timestamp}</>,
}));

const mockUseLevelAudit = useLevelAudit as jest.MockedFunction<
  typeof useLevelAudit
>;
const mockUseLevelHistory = useLevelHistory as jest.MockedFunction<
  typeof useLevelHistory
>;

const DECISION = {
  decision_id: "10000000-0000-0000-0000-000000000001",
  current: {
    event_id: "00000000-0000-0000-0000-000000000002",
    decision_id: "10000000-0000-0000-0000-000000000001",
    downstream_repo: "vendor/backend",
    previous_level: "L2",
    new_level: "L3",
    decision_kind: "promotion" as const,
    decision_source: "automation" as const,
    event_state: "applied" as const,
    evaluation_window_start: "2026-10-01 00:00:00",
    evaluation_window_end: "2026-10-15 00:00:00",
    criteria_snapshot_json: "",
    reason: "",
    proposal_pr_url: "",
    approval_pr_url: "",
    configuration_commit_sha: "a1b2c3d4e5f6",
    configuration_commit_url:
      "https://github.com/pytorch/pytorch/commit/a1b2c3d4e5f6",
    decision_actor: "crcr-promotion-bot",
    recorded_by: "crcr-promotion-bot",
    recorded_at: "2026-10-16 01:00:00",
    effective_at: "2026-10-16 01:00:00",
    criteria_schema_version: 1,
  },
  events: [
    {
      event_id: "00000000-0000-0000-0000-000000000001",
      decision_id: "10000000-0000-0000-0000-000000000001",
      downstream_repo: "vendor/backend",
      previous_level: "L2",
      new_level: "L3",
      decision_kind: "promotion" as const,
      decision_source: "automation" as const,
      event_state: "proposed" as const,
      evaluation_window_start: "2026-10-01 00:00:00",
      evaluation_window_end: "2026-10-15 00:00:00",
      criteria_snapshot_json: JSON.stringify({
        criteria: [
          {
            name: "Job Pass Rate",
            target: "≥ 90%",
            observed: "97.2%",
            verdict: "met",
          },
        ],
      }),
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
    },
  ],
};

describe("CrcrLevelAudit", () => {
  beforeEach(() => {
    mockUseLevelHistory.mockReturnValue({
      events: [],
      error: undefined,
      loaded: true,
    });
  });

  test("renders the selected decision's persisted audit details", () => {
    mockUseLevelAudit.mockReturnValue({
      decisions: [
        {
          ...DECISION,
          events: [...DECISION.events, DECISION.current],
        },
      ],
      error: undefined,
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelAudit repoFullName="vendor/backend" />
    );

    expect(html).toContain("Configured-Level History");
    expect(html).toContain("Automated promotion");
    expect(html).toContain("All promotion criteria qualified.");
    expect(html).toContain("crcr-promotion-bot");
    expect(html).toContain("Job Pass Rate");
    expect(html).toContain("Proposal");
    expect(html).toContain("Applied configuration");
    expect(html).toContain("a1b2c3d4e5f6");
    expect(html).toContain("Proposed");
    expect(html).toContain("Applied");
  });

  test("does not present a query failure as an empty audit", () => {
    mockUseLevelAudit.mockReturnValue({
      decisions: [],
      error: new Error("ClickHouse unavailable"),
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelAudit repoFullName="vendor/backend" />
    );

    expect(html).toContain("temporarily unavailable");
    expect(html).toContain("Audit unavailable");
  });

  test("presents dispatch-observed history in the same selectable timeline", () => {
    mockUseLevelAudit.mockReturnValue({
      decisions: [],
      error: undefined,
      loaded: true,
    });
    mockUseLevelHistory.mockReturnValue({
      events: [
        {
          changed_at: "2026-10-16 01:00:00",
          previous_level: "L2",
          new_level: "L3",
        },
      ],
      error: undefined,
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelAudit repoFullName="vendor/backend" />
    );

    expect(html).toContain("1 observed event · 0 audit decisions");
    expect(html).toContain("Dispatch observed");
    expect(html).toContain("Observed configured level: L2 → L3");
    expect(html).toContain("CRCR dispatch records");
    expect(html).not.toContain("Configured-Level Decision Audit");
  });

  test("does not show an applied configuration fallback before a decision applies", () => {
    mockUseLevelAudit.mockReturnValue({
      decisions: [
        {
          ...DECISION,
          current: DECISION.events[0],
          events: [DECISION.events[0]],
        },
      ],
      error: undefined,
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelAudit repoFullName="vendor/backend" />
    );

    expect(html).toContain("Proposal");
    expect(html).not.toContain("Applied configuration");
  });

  test("uses the applied event for effective time and one event for a window", () => {
    const superseded = {
      ...DECISION.current,
      event_id: "00000000-0000-0000-0000-000000000003",
      event_state: "superseded",
      recorded_at: "2026-10-17 01:00:00",
      effective_at: null,
      evaluation_window_start: null,
      evaluation_window_end: "2026-10-17 01:00:00",
      configuration_commit_sha: "",
      configuration_commit_url: "",
    };
    const proposed = {
      ...DECISION.events[0],
      evaluation_window_start: "2026-10-01 00:00:00",
      evaluation_window_end: null,
    };
    mockUseLevelAudit.mockReturnValue({
      decisions: [
        {
          ...DECISION,
          current: superseded,
          events: [proposed, DECISION.current, superseded],
        },
      ],
      error: undefined,
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelAudit repoFullName="vendor/backend" />
    );

    expect(html).toContain("2026-10-16 01:00:00");
    expect(html).toContain("Evaluation window");
    expect(html).toContain("2026-10-01 00:00:00");
    expect(html).toContain("2026-10-15 00:00:00");
  });

  test("renders unknown audit enum values without throwing", () => {
    mockUseLevelAudit.mockReturnValue({
      decisions: [
        {
          ...DECISION,
          current: {
            ...DECISION.current,
            decision_kind: "",
            decision_source: "",
            event_state: "",
          },
        },
      ],
      error: undefined,
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelAudit repoFullName="vendor/backend" />
    );

    expect(html).toContain("Unknown");
  });
});
