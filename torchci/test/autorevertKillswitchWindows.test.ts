import {
  foldKillswitchWindows,
  KillswitchLabelEvent,
  killswitchWindowAt,
} from "../lib/autorevert/killswitchWindows";

function ev(
  issue: number,
  action: "labeled" | "unlabeled",
  time: string,
  closed: string = ""
): KillswitchLabelEvent {
  return {
    issue_number: issue,
    action,
    event_time: time,
    issue_closed_at: closed,
  };
}

describe("foldKillswitchWindows", () => {
  it("pairs labeled with the next unlabeled on the same issue", () => {
    const out = foldKillswitchWindows([
      ev(183016, "labeled", "2026-05-09 01:36:48"),
      ev(183016, "unlabeled", "2026-05-12 16:47:26"),
    ]);
    expect(out).toEqual([
      {
        issue_number: 183016,
        on: "2026-05-09 01:36:48",
        off: "2026-05-12 16:47:26",
      },
    ]);
  });

  it("falls back to issue closed_at when no unlabeled is present", () => {
    const out = foldKillswitchWindows([
      ev(170248, "labeled", "2025-12-11 22:46:59", "2025-12-11T22:59:45Z"),
    ]);
    expect(out).toEqual([
      {
        issue_number: 170248,
        on: "2025-12-11 22:46:59",
        off: "2025-12-11T22:59:45Z",
      },
    ]);
  });

  it("leaves off=null when label is still active on an open issue", () => {
    const out = foldKillswitchWindows([
      ev(999, "labeled", "2026-05-15 10:00:00"),
    ]);
    expect(out).toEqual([
      { issue_number: 999, on: "2026-05-15 10:00:00", off: null },
    ]);
  });

  it("handles multiple label-unlabel cycles on the same issue", () => {
    const out = foldKillswitchWindows([
      ev(1, "labeled", "2026-01-01 00:00:00"),
      ev(1, "unlabeled", "2026-01-02 00:00:00"),
      ev(1, "labeled", "2026-01-03 00:00:00"),
      ev(1, "unlabeled", "2026-01-04 00:00:00"),
    ]);
    expect(out).toEqual([
      {
        issue_number: 1,
        on: "2026-01-01 00:00:00",
        off: "2026-01-02 00:00:00",
      },
      {
        issue_number: 1,
        on: "2026-01-03 00:00:00",
        off: "2026-01-04 00:00:00",
      },
    ]);
  });

  it("returns windows sorted by on_ts across issues", () => {
    const out = foldKillswitchWindows([
      ev(2, "labeled", "2026-02-01 00:00:00", "2026-02-02T00:00:00Z"),
      ev(1, "labeled", "2026-01-01 00:00:00", "2026-01-02T00:00:00Z"),
    ]);
    expect(out.map((w) => w.issue_number)).toEqual([1, 2]);
  });
});

describe("killswitchWindowAt", () => {
  const windows = [
    {
      issue_number: 183016,
      on: "2026-05-09 01:36:48",
      off: "2026-05-12 16:47:26",
    },
  ];

  it("returns the matching window when t falls inside", () => {
    const w = killswitchWindowAt(windows, "2026-05-12T16:11:46Z");
    expect(w?.issue_number).toBe(183016);
  });

  it("returns null when t is before all windows", () => {
    expect(killswitchWindowAt(windows, "2026-05-08T00:00:00Z")).toBeNull();
  });

  it("returns null when t is after all windows", () => {
    expect(killswitchWindowAt(windows, "2026-05-13T00:00:00Z")).toBeNull();
  });

  it("treats null off as still-active", () => {
    const open = [{ issue_number: 1, on: "2026-05-01 00:00:00", off: null }];
    const w = killswitchWindowAt(open, "2026-12-01T00:00:00Z");
    expect(w?.issue_number).toBe(1);
  });
});
