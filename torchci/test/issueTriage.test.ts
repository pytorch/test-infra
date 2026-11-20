import dayjs from "dayjs";
import {
  ALL_START_DATE,
  githubQueueUrl,
  isBeforeHistory,
  parseLabels,
  parseStart,
  ROLLOUT_DATE,
  slaLevel,
  slaPct,
} from "lib/triage/issueTriage";

describe("parseStart", () => {
  test("defaults to the rollout date", () => {
    expect(parseStart(undefined)).toEqual({
      preset: "rollout",
      date: ROLLOUT_DATE,
    });
    expect(parseStart("")).toEqual({ preset: "rollout", date: ROLLOUT_DATE });
  });

  test("all covers every issue", () => {
    expect(parseStart("all")).toEqual({ preset: "all", date: ALL_START_DATE });
  });

  test("relative presets count back from today", () => {
    expect(parseStart("30d")).toEqual({
      preset: "30d",
      date: dayjs().subtract(30, "day").format("YYYY-MM-DD"),
    });
  });

  test("a date is a custom start", () => {
    expect(parseStart("2026-01-15")).toEqual({
      preset: "custom",
      date: "2026-01-15",
    });
  });

  test("anything else falls back to the rollout date", () => {
    // The date goes into SQL as a parameter, but only well-formed dates should
    // ever reach it.
    for (const bad of ["2026-1-5", "yesterday", "2026-13-45", "' OR 1=1"]) {
      expect(parseStart(bad).date).toEqual(ROLLOUT_DATE);
    }
  });
});

test("isBeforeHistory", () => {
  expect(isBeforeHistory(ALL_START_DATE)).toBe(true);
  expect(isBeforeHistory("2025-04-02")).toBe(true);
  expect(isBeforeHistory("2025-04-03")).toBe(false);
  expect(isBeforeHistory(ROLLOUT_DATE)).toBe(false);
});

describe("githubQueueUrl", () => {
  function searchOf(url: string) {
    return new URL(url).searchParams.get("q");
  }

  test("excludes every state label and quotes labels", () => {
    expect(
      searchOf(githubQueueUrl(["module: correctness (silent)"], "2026-10-02"))
    ).toEqual(
      "repo:pytorch/pytorch is:issue is:open " +
        'label:"module: correctness (silent)" ' +
        '-label:"needs reproduction" -label:"needs research" ' +
        '-label:"needs design" -label:"actionable" -label:"won\'t fix" ' +
        "created:>=2026-10-02"
    );
  });

  test("all has no date filter", () => {
    expect(
      searchOf(githubQueueUrl(["oncall: pt2"], ALL_START_DATE))
    ).not.toMatch(/created:/);
  });
});

test("SLA bands", () => {
  expect(slaPct(0, 0)).toBeNull();
  expect(slaLevel(null)).toEqual("none");
  expect(slaLevel(slaPct(8, 10))).toEqual("good");
  expect(slaLevel(slaPct(5, 10))).toEqual("warn");
  expect(slaLevel(slaPct(4, 10))).toEqual("bad");
});

test("githubQueueUrl ORs several labels", () => {
  const q = new URL(
    githubQueueUrl(["module: nn", "module: autograd"], ALL_START_DATE)
  ).searchParams.get("q");
  expect(q).toContain('label:"module: nn","module: autograd" ');
});

test("parseLabels", () => {
  expect(parseLabels(undefined)).toEqual([]);
  expect(parseLabels("module: nn")).toEqual(["module: nn"]);
  expect(
    parseLabels(["module: nn", " module: autograd ", "", "module: nn"])
  ).toEqual(["module: nn", "module: autograd"]);
});
