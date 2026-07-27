import { JobAnnotation, JobsPerCommitData } from "lib/types";
import {
  approximateFailureByType,
  approximateFailureByTypePercent,
  BROKEN_TRUNK_THRESHOLD,
  computeSoleBlockers,
  jobTypeOf,
  SoleBlockerCommit,
  soleBlockerCommitRange,
} from "../lib/metricUtils";

describe("Approximate failures by its categories", () => {
  test("no data", () => {
    expect(approximateFailureByType(undefined)).toStrictEqual({});
    expect(approximateFailureByType([])).toStrictEqual({});
  });

  test("flaky failures", () => {
    const data: JobsPerCommitData[] = [
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobB"],
        successes: ["jobA"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobB"],
        successes: ["jobA"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: [],
        successes: ["jobA", "jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
    ];

    expect(approximateFailureByType(data)).toStrictEqual({
      jobA: {
        [JobAnnotation.INFRA_BROKEN]: 0,
        [JobAnnotation.BROKEN_TRUNK]: 0,
        [JobAnnotation.TEST_FLAKE]: 2,
      },
      jobB: {
        [JobAnnotation.INFRA_BROKEN]: 0,
        [JobAnnotation.BROKEN_TRUNK]: 0,
        [JobAnnotation.TEST_FLAKE]: 2,
      },
    });
  });

  test("broken trunk failures", () => {
    const data: JobsPerCommitData[] = [
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA", "jobB"],
        successes: [],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: [],
        successes: ["jobA", "jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
    ];

    expect(approximateFailureByType(data)).toStrictEqual({
      jobA: {
        [JobAnnotation.INFRA_BROKEN]: 0,
        [JobAnnotation.BROKEN_TRUNK]: 3,
        [JobAnnotation.TEST_FLAKE]: 1,
      },
      jobB: {
        [JobAnnotation.INFRA_BROKEN]: 0,
        [JobAnnotation.BROKEN_TRUNK]: 0,
        [JobAnnotation.TEST_FLAKE]: 1,
      },
    });
  });

  test("outage failures", () => {
    const data: JobsPerCommitData[] = [
      {
        sha: "",
        author: "",
        failures: ["jobA", "jobB", "jobC", "jobD", "jobE"],
        successes: ["jobF"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA", "jobB", "jobC", "jobD", "jobE", "jobF"],
        successes: [],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA", "jobB", "jobC", "jobD", "jobE"],
        successes: ["jobF"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: [],
        successes: ["jobA", "jobB", "jobC", "jobD", "jobE", "jobF"],
        time: "",
      },
    ];

    const outage_threshold = 5;
    expect(
      approximateFailureByType(data, BROKEN_TRUNK_THRESHOLD, outage_threshold)
    ).toStrictEqual({
      jobA: {
        [JobAnnotation.INFRA_BROKEN]: 3,
        [JobAnnotation.BROKEN_TRUNK]: 3,
        [JobAnnotation.TEST_FLAKE]: 0,
      },
      jobB: {
        [JobAnnotation.INFRA_BROKEN]: 3,
        [JobAnnotation.BROKEN_TRUNK]: 3,
        [JobAnnotation.TEST_FLAKE]: 0,
      },
      jobC: {
        [JobAnnotation.INFRA_BROKEN]: 3,
        [JobAnnotation.BROKEN_TRUNK]: 3,
        [JobAnnotation.TEST_FLAKE]: 0,
      },
      jobD: {
        [JobAnnotation.INFRA_BROKEN]: 3,
        [JobAnnotation.BROKEN_TRUNK]: 3,
        [JobAnnotation.TEST_FLAKE]: 0,
      },
      jobE: {
        [JobAnnotation.INFRA_BROKEN]: 3,
        [JobAnnotation.BROKEN_TRUNK]: 3,
        [JobAnnotation.TEST_FLAKE]: 0,
      },
      jobF: {
        [JobAnnotation.INFRA_BROKEN]: 1,
        [JobAnnotation.BROKEN_TRUNK]: 0,
        [JobAnnotation.TEST_FLAKE]: 1,
      },
    });
  });

  test("show percentage", () => {
    const data: JobsPerCommitData[] = [
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA", "jobB"],
        successes: [],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: [],
        successes: ["jobA", "jobB"],
        time: "",
      },
      {
        sha: "",
        author: "",
        failures: ["jobA"],
        successes: ["jobB"],
        time: "",
      },
    ];

    expect(approximateFailureByTypePercent(data)).toStrictEqual({
      jobA: {
        [JobAnnotation.INFRA_BROKEN]: 0,
        [JobAnnotation.BROKEN_TRUNK]: 60,
        [JobAnnotation.TEST_FLAKE]: 20,
      },
      jobB: {
        [JobAnnotation.INFRA_BROKEN]: 0,
        [JobAnnotation.BROKEN_TRUNK]: 0,
        [JobAnnotation.TEST_FLAKE]: 20,
      },
    });
  });
});

describe("Sole viable/strict blockers", () => {
  test("no data", () => {
    expect(computeSoleBlockers(undefined)).toStrictEqual([]);
    expect(computeSoleBlockers([])).toStrictEqual([]);
  });

  test("job type folds workflow + base name, drops config", () => {
    expect(jobTypeOf("trunk / A / test (default)")).toBe("trunk / A");
    expect(jobTypeOf("trunk / A / build")).toBe("trunk / A");
    expect(jobTypeOf("lint / quick-checks")).toBe("lint / quick-checks");
  });

  test("config-sole vs job-type-sole", () => {
    // 5 evaluated commits; the last is green and only counts toward the total.
    const data: SoleBlockerCommit[] = [
      // A/default is the only blocker -> sole at both granularities
      { sha: "1", time: "", blocking: ["trunk / A / test (default)"] },
      // two configs of A -> not config-sole, but A is still the only job type
      {
        sha: "2",
        time: "",
        blocking: ["trunk / A / test (default)", "trunk / A / test (inductor)"],
      },
      // two different job types -> sole at neither granularity
      {
        sha: "3",
        time: "",
        blocking: ["trunk / A / test (default)", "trunk / B / build"],
      },
      // B/build is the only blocker
      { sha: "4", time: "", blocking: ["trunk / B / build"] },
      // green commit
      { sha: "5", time: "", blocking: [] },
    ];

    expect(computeSoleBlockers(data)).toStrictEqual([
      // A/default: sole 1/5, job type A sole 2/5 (commits 1 and 2)
      {
        name: "trunk / A / test (default)",
        sole: 20,
        soleJobType: 40,
      },
      // A/inductor is dropped: never individually sole, and its job type A
      // already has an actionable row (A/default), so it is redundant.
      // B/build: sole 1/5, job type B sole 1/5
      { name: "trunk / B / build", sole: 20, soleJobType: 20 },
    ]);
  });

  test("combo-only job type keeps its configs (no sole sibling to fall back on)", () => {
    // A job type that only ever blocks via two of its configs failing together,
    // so no single config is individually sole. Both rows must be kept so the
    // job-type signal is not hidden.
    const data: SoleBlockerCommit[] = [
      {
        sha: "1",
        time: "",
        blocking: ["trunk / C / test (x)", "trunk / C / test (y)"],
      },
      { sha: "2", time: "", blocking: [] },
    ];

    expect(computeSoleBlockers(data)).toStrictEqual([
      { name: "trunk / C / test (x)", sole: 0, soleJobType: 50 },
      { name: "trunk / C / test (y)", sole: 0, soleJobType: 50 },
    ]);
  });

  test("commit range picks oldest/newest regardless of input order", () => {
    expect(soleBlockerCommitRange(undefined)).toStrictEqual({ count: 0 });
    expect(soleBlockerCommitRange([])).toStrictEqual({ count: 0 });

    const data: SoleBlockerCommit[] = [
      {
        sha: "bbb",
        time: "2026-07-27T09:00:00Z",
        title: "newer",
        blocking: [],
      },
      {
        sha: "aaa",
        time: "2026-07-26T09:00:00Z",
        title: "older",
        blocking: [],
      },
      { sha: "ccc", time: "2026-07-27T03:00:00Z", title: "mid", blocking: [] },
    ];
    expect(soleBlockerCommitRange(data)).toStrictEqual({
      count: 3,
      oldest: { sha: "aaa", title: "older", time: "2026-07-26T09:00:00Z" },
      newest: { sha: "bbb", title: "newer", time: "2026-07-27T09:00:00Z" },
    });
  });
});
