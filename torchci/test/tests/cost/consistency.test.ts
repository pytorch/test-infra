// The runner-hours answer beside this file (answer.json, an answer of GET
// /api/tests/cost) checked against itself, and rates.json read with its
// notes; for every scope and highlight a reader can choose, the view's parts
// add up to the scope.

import { RunnerHoursSchema } from "lib/api/tests/cost/types";
import { parseRates } from "lib/tests/cost/rates";
import {
  type CostChoices,
  computeView,
  NOT_PROBED,
  prepareRunnerHours,
} from "lib/tests/cost/runnerHours";
import ANSWER_JSON from "./answer.json";
import RATES_JSON from "./rates.json";

const answer = RunnerHoursSchema.parse(ANSWER_JSON);
const prepared = prepareRunnerHours(answer);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
const RUNNER_HOURS = 578;

const sum = (xs: Iterable<number>) => Array.from(xs).reduce((a, b) => a + b, 0);

// The choices a reader can make: every workflow, the PR Critical Path and
// single workflows, crossed with no highlight, an owner, a bucket, a
// machine, Unknown machine and an owner on a machine.
const SCOPES = [[], ["pull", "trunk"], ["pull"], ["inductor"], ["xpu"]];
const HIGHLIGHTS = [
  { owners: [], machines: [] },
  { owners: ["inductor"], machines: [] },
  { owners: ["unattributed:no_test_reports"], machines: [] },
  { owners: [], machines: ["NVIDIA L4"] },
  { owners: [], machines: [NOT_PROBED] },
  { owners: ["dynamo"], machines: ["Linux x86_64 avx512"] },
];
const CHOICES: CostChoices[] = SCOPES.flatMap((workflows) =>
  HIGHLIGHTS.map((h) => ({ workflows, ...h }))
);

describe("the example answer and rates file", () => {
  test("answer.json is an answer of the API whose rows hold the window's runner-hours", () => {
    expect(sum(answer.rows.map((r) => r.runner_hours))).toBeCloseTo(
      RUNNER_HOURS,
      9
    );
    expect(prepared.total).toBeCloseTo(RUNNER_HOURS, 9);
    // Unknown machine's runner-hours are its unprobed labels'.
    expect(
      sum(
        answer.rows.filter((r) => r.machine === "").map((r) => r.runner_hours)
      )
    ).toBe(sum(answer.unprobed_labels.map((l) => l.runner_hours)));
    // Each row's label is among its machine's.
    for (const row of answer.rows.filter((r) => r.machine !== "")) {
      expect(
        answer.machines.find((m) => m.machine === row.machine)?.labels
      ).toContain(row.label);
    }
    // Each bucket's contributors are its runner-hours, by label or file.
    for (const bucket of answer.contributors.map((c) => c.bucket)) {
      expect(
        sum(
          answer.contributors
            .filter((c) => c.bucket === bucket)
            .map((c) => c.runner_hours)
        )
      ).toBeCloseTo(
        sum(
          answer.rows
            .filter((r) => r.owner === bucket)
            .map((r) => r.runner_hours)
        ),
        9
      );
    }
  });

  test("rates.json reads with its notes", () => {
    expect([rates.validFrom, rates.basis]).toEqual([
      "2026-10-01",
      "example rates for tests, not real prices",
    ]);
  });
});

describe("every view adds up", () => {
  test.each(CHOICES)("%o", (choices) => {
    const view = computeView(prepared, choices);
    const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);
    close(sum(prepared.workflowTotal), prepared.total);
    close(sum(prepared.machineTotal), prepared.total);
    close(sum(view.machineScope), view.scopeTotal);
    close(sum(view.ownerScope.values()), view.scopeTotal);
  });
});
