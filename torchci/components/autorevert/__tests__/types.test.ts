import {
  ensureUtc,
  eventUrl,
  getHighlightsForOutcome,
  Outcome,
  parseChTimestamp,
  parseRunId,
} from "../types";

describe("ensureUtc", () => {
  it("appends Z to bare timestamps", () => {
    expect(ensureUtc("2026-04-08T13:45:00")).toBe("2026-04-08T13:45:00Z");
  });

  it("does not double-append Z", () => {
    expect(ensureUtc("2026-04-08T13:45:00Z")).toBe("2026-04-08T13:45:00Z");
  });

  it("handles empty string", () => {
    expect(ensureUtc("")).toBe("");
  });
});

describe("parseChTimestamp", () => {
  it("parses CH timestamp as UTC", () => {
    const ms = parseChTimestamp("2026-04-08T12:00:00");
    expect(new Date(ms).toISOString()).toBe("2026-04-08T12:00:00.000Z");
  });

  it("handles already-Z-suffixed", () => {
    const ms = parseChTimestamp("2026-04-08T12:00:00Z");
    expect(new Date(ms).toISOString()).toBe("2026-04-08T12:00:00.000Z");
  });

  it("handles empty/null gracefully", () => {
    const ms = parseChTimestamp("");
    expect(ms).toBe(new Date("1970-01-01Z").getTime());
  });
});

describe("parseRunId", () => {
  it("extracts run_id from event name", () => {
    expect(
      parseRunId(
        "wf=trunk kind=test id=test_cuda.py::test_foo run=23456789 attempt=1"
      )
    ).toBe(23456789);
  });

  it("returns null for names without run_id", () => {
    expect(parseRunId("some random name")).toBeNull();
  });
});

describe("eventUrl", () => {
  it("builds job URL when job_id and run_id present", () => {
    const url = eventUrl("pytorch/pytorch", {
      status: "failure",
      started_at: "2026-04-08T12:00:00",
      name: "wf=trunk kind=test id=foo run=123 attempt=1",
      job_id: 456,
    });
    expect(url).toBe(
      "https://github.com/pytorch/pytorch/actions/runs/123/job/456"
    );
  });

  it("builds run URL when only run_id present", () => {
    const url = eventUrl("pytorch/pytorch", {
      status: "success",
      started_at: "2026-04-08T12:00:00",
      name: "wf=trunk kind=test id=foo run=123 attempt=1",
    });
    expect(url).toBe("https://github.com/pytorch/pytorch/actions/runs/123");
  });

  it("returns null when no run_id in name", () => {
    const url = eventUrl("pytorch/pytorch", {
      status: "pending",
      started_at: "2026-04-08T12:00:00",
      name: "no run id here",
    });
    expect(url).toBeNull();
  });
});

describe("getHighlightsForOutcome", () => {
  it("returns suspect/baseline/newer-fail for AutorevertPattern", () => {
    const outcome: Outcome = {
      type: "AutorevertPattern",
      data: {
        workflow_name: "trunk",
        suspected_commit: "sha_suspect",
        older_successful_commit: "sha_baseline",
        newer_failing_commits: ["sha_newer1", "sha_newer2"],
      },
    };
    const highlights = getHighlightsForOutcome(outcome);
    expect(highlights.get("sha_suspect")).toBe("suspected");
    expect(highlights.get("sha_baseline")).toBe("baseline");
    expect(highlights.get("sha_newer1")).toBe("newer-fail");
    expect(highlights.get("sha_newer2")).toBe("newer-fail");
    expect(highlights.get("sha_other")).toBeUndefined();
  });

  it("returns restart for RestartCommits", () => {
    const outcome: Outcome = {
      type: "RestartCommits",
      data: { commit_shas: ["sha_a", "sha_b"] },
    };
    const highlights = getHighlightsForOutcome(outcome);
    expect(highlights.get("sha_a")).toBe("restart");
    expect(highlights.get("sha_b")).toBe("restart");
  });

  it("returns empty map for Ineligible", () => {
    const outcome: Outcome = {
      type: "Ineligible",
      data: { reason: "flaky", message: "mixed outcomes" },
    };
    const highlights = getHighlightsForOutcome(outcome);
    expect(highlights.size).toBe(0);
  });

  it("returns empty map for undefined", () => {
    expect(getHighlightsForOutcome(undefined).size).toBe(0);
  });
});
