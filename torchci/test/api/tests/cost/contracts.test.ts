// The drill, bars, banner and cases answers' zod schemas infer exactly the interfaces the page codes
// against (lib/api/tests/cost/contracts.ts), and every answer's echo
// rebuilds the URL that asked for it.
import {
  type CostCases,
  type CostCoverage,
  type CostCoverageJobs,
  type CostScope,
  type CostSeries,
  casesEcho,
  costCasesUrl,
  costCoverageJobsUrl,
  costCoverageUrl,
  costScopeUrl,
  costSeriesUrl,
  coverageEcho,
  current,
  decodeTrail,
  encodeTrail,
  jobsEcho,
  scopeEcho,
  seriesEcho,
} from "lib/api/tests/cost/contracts";
import { parseTrail } from "lib/api/tests/cost/parameters";
import {
  CostCasesSchema,
  CostCoverageJobsSchema,
  CostCoverageSchema,
  CostScopeSchema,
  CostSeriesSchema,
} from "lib/api/tests/cost/types";
import type { z } from "zod/v4";

// Assignable both ways, checked by tsc: a field added, dropped or retyped on
// either side fails the type check.
type Both<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exact = <T extends true>(t: T) => t;
exact<Both<z.infer<typeof CostScopeSchema>, CostScope>>(true);
exact<Both<z.infer<typeof CostSeriesSchema>, CostSeries>>(true);
exact<Both<z.infer<typeof CostCasesSchema>, CostCases>>(true);
exact<Both<z.infer<typeof CostCoverageSchema>, CostCoverage>>(true);
exact<Both<z.infer<typeof CostCoverageJobsSchema>, CostCoverageJobs>>(true);

const A = { from: "2026-11-05", to: "2026-11-11" };
const B = { from: "2026-11-12", to: "2026-11-18" };
const TRAIL = decodeTrail("o:inductor;m:Linux%20x86_64%20avx512");
const SIDE = { days: [], pushes: [], filling: [] };

describe("the drill, bars, banner and cases answers", () => {
  test("each echo rebuilds its request's URL, workflows in any order", () => {
    const scope = CostScopeSchema.parse({
      repo: "pytorch/pytorch",
      workflows: ["pull", "trunk"],
      trail: TRAIL,
      by: "f",
      a: A,
      b: B,
      piece: "week",
      sides: [SIDE, SIDE],
      pieces: [{ side: 1, from: "2026-11-12", to: "2026-11-15" }],
      children: ["test/test_ops.py"],
      info: [{ coOwners: ["inductor", "module: tests"] }],
      labels: ["linux.2xlarge"],
      cells: [[1, 0, 0, 0, 1.5, 0.25]],
      tests: [[1, 0, 1, 0]],
      query_duration_ms: 1,
    });
    expect(scopeEcho(scope)).toBe(
      costScopeUrl("pytorch/pytorch", ["trunk", "pull"], A, B, TRAIL, "f")
    );
    const series = CostSeriesSchema.parse({
      repo: "pytorch/pytorch",
      workflows: [],
      trail: [],
      by: "o",
      from: "2026-10-08",
      to: "2026-11-18",
      days: ["2026-11-18"],
      pushes: [86],
      filling: [],
      children: ["inductor"],
      rest: false,
      labels: ["x"],
      cells: [[0, 0, 0, 2, 1]],
      query_duration_ms: 1,
    });
    const range = { from: "2026-10-08", to: "2026-11-18" };
    expect(seriesEcho(series)).toBe(
      costSeriesUrl("pytorch/pytorch", [], [], "o", range)
    );
    const cases = CostCasesSchema.parse({
      repo: "pytorch/pytorch",
      file: "test/test_ops.py",
      machine: "NVIDIA L4",
      environment: null,
      a: { ...A, covered_from: "2026-11-06", covered_days: 6 },
      b: { ...B, covered_from: "2026-11-12", covered_days: 7 },
      status: "too_big",
      lanes: [
        { environment: "6736396900082420103", estimate: 300, tooBig: true },
      ],
      environments: [],
      env_vars: [],
      tests: [],
      configs: [],
      cells: [],
      ranked_of: 0,
      query_duration_ms: 1,
    });
    expect(casesEcho(cases)).toBe(
      costCasesUrl("pytorch/pytorch", "test/test_ops.py", "NVIDIA L4", A, B)
    );
    const coverage = CostCoverageSchema.parse({
      repo: "pytorch/pytorch",
      workflows: ["trunk"],
      ...B,
      days: [],
      labels: [],
      cells: [],
      with_reports_h: 0,
      owned_h: 0,
      query_duration_ms: 1,
    });
    expect(coverageEcho(coverage)).toBe(
      costCoverageUrl("pytorch/pytorch", ["trunk"], B)
    );
    const jobs = CostCoverageJobsSchema.parse({
      repo: "pytorch/pytorch",
      org: "pytorch",
      ...B,
      repos: 21,
      labels: [],
      cells: [],
      query_duration_ms: 1,
    });
    expect(jobsEcho(jobs)).toBe(costCoverageJobsUrl("pytorch/pytorch", B));
    // A kept answer for another URL is not current.
    expect(
      current(jobs, costCoverageJobsUrl("pytorch/pytorch", A), jobsEcho)
    ).toBeUndefined();
    expect(
      current(jobs, costCoverageJobsUrl("pytorch/pytorch", B), jobsEcho)
    ).toBe(jobs);
  });

  test("the API takes exactly the trails the page writes", () => {
    for (const text of [
      "",
      "o:inductor",
      "m:Unknown%20machine;o:unattributed%3Ano_owner",
      "o:inductor;m:NVIDIA%20L4;f:test%2Ftest_ops.py",
    ]) {
      expect(parseTrail(text)).toEqual(decodeTrail(text));
      expect(encodeTrail(parseTrail(text) ?? [])).toBe(text);
    }
    for (const text of [
      "o:a;o:b",
      "o:a b",
      "q:x",
      "o:",
      "f:x",
      "f:x;o:a",
      ";",
    ]) {
      expect([text, parseTrail(text)]).toEqual([text, null]);
    }
  });
});
