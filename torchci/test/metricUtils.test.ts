import {
  approximateFailureByType,
  approximateFailureByTypePercent,
  BROKEN_TRUNK_THRESHOLD,
} from "../lib/metricUtils";
import { JobsPerCommitData, JobAnnotation } from "lib/types";

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
