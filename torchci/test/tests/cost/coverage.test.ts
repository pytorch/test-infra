// The coverage banner's arithmetic (lib/tests/cost/coverage.ts) on the live
// /coverage (Nov 12–18) and /coverage/jobs (Nov 6–19) answers beside this
// file, captured from pytorch/pytorch on 2026-11-19: the strip's shares, the builds part derived from job hours, the
// fallback when job hours are missing, the scoped part, $ widths, the
// bracket's label, the ⓘ's lines and the ghost beside FAKE AWS totals.

import type {
  CostCoverage,
  CostCoverageJobs,
  DayRange,
  Pricer,
} from "lib/api/tests/cost/contracts";
import {
  billLine,
  bracketLabel,
  clampWarning,
  coverageDetails,
  coverageEmpty,
  coverageHull,
  coverageNote,
  coverageStrip,
  dayRuns,
  greyShare,
  jobsSource,
  LEFT_OUT,
  outsideSplit,
  pctLabel,
  shortRange,
  STRIP_PARTS,
  testDays,
  wholePercents,
} from "lib/tests/cost/coverage";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JOBS_JSON from "./coverage_jobs.json";
import TESTS_JSON from "./coverage_tests.json";

const tests = TESTS_JSON as unknown as CostCoverage;
const jobs = JOBS_JSON as unknown as CostCoverageJobs;
const B: DayRange = { from: "2026-11-12", to: "2026-11-18" };
const END = "2026-11-20";

const sum = (values: number[]) => values.reduce((a, v) => a + v, 0);
const close = (a: number, b: number, digits = 6) =>
  expect(a).toBeCloseTo(b, digits);
// Σ of an answer's cells in B, by segment index.
function testHoursInB(answer: CostCoverage, segment?: number): number {
  return sum(
    answer.cells
      .filter(
        ([d, s]) =>
          answer.days[d] >= B.from &&
          answer.days[d] <= B.to &&
          (segment === undefined || s === segment)
      )
      .map(([, , , h]) => h)
  );
}
function jobHoursInB(segment: number): number {
  const day = (i: number) =>
    new Date(Date.parse(`${jobs.from}T00:00:00Z`) + i * 864e5)
      .toISOString()
      .slice(0, 10);
  return sum(
    jobs.cells
      .filter(([d, s]) => day(d) >= B.from && day(d) <= B.to && s === segment)
      .map(([, , , h]) => h)
  );
}
const part = (strip: ReturnType<typeof coverageStrip>, name: string) =>
  strip.segments.find((s) => s.part === name);
// The ⓘ's lines, and the line starting with a prefix.
const details = (
  strip: ReturnType<typeof coverageStrip>,
  jobs: Parameters<typeof coverageDetails>[1] = "ok"
) => coverageDetails(strip, jobs);
const line = (lines: string[], prefix: string) =>
  lines.find((l) => l.startsWith(prefix));
// Every part but the ghost, which only $ with totals adds.
const JOB_PARTS = STRIP_PARTS.filter((p) => p !== "outside_jobs");

describe("coverage strip", () => {
  test("org base: the six parts in order, shares summing to 1, sums matching both answers", () => {
    const strip = coverageStrip(tests, jobs, B, null, "hours");
    expect(strip.base).toBe("org");
    expect(strip.days).toHaveLength(7);
    expect(strip.segments.map((s) => s.part)).toEqual(
      JOB_PARTS.filter((p) => p !== "outside_view")
    );
    expect(strip.outside).toBeNull();
    close(strip.jobs, strip.total);
    close(sum(strip.segments.map((s) => s.share)), 1);
    // The blue parts are test_cost's B total; other repos are workflow_job's.
    close(strip.page, testHoursInB(tests), 3);
    close(part(strip, "other_repos")!.hours, jobHoursInB(0), 3);
    // Builds = repo jobs − test jobs, never negative.
    const builds = part(strip, "builds")!.hours;
    expect(builds).toBeGreaterThanOrEqual(0);
    expect(jobHoursInB(1) - testHoursInB(tests)).toBeGreaterThanOrEqual(0);
    close(builds, jobHoursInB(1) - testHoursInB(tests), 0);
    close(strip.total, jobHoursInB(0) + jobHoursInB(1), 0);
    // Shares near query-validation.md's (other repos 19.6%, builds 13.4%, …).
    expect(Math.round(part(strip, "other_repos")!.share * 100)).toBe(20);
    expect(Math.round(part(strip, "running")!.share * 100)).toBe(38);
    expect(greyShare(strip)).toBeCloseTo(
      part(strip, "other_repos")!.share + part(strip, "builds")!.share
    );
  });

  test("builds never go negative where test hours exceed the job hours", () => {
    // The repository's jobs on its largest test label lose all their hours.
    const largest = jobs.labels.indexOf(tests.labels[0]);
    const short: CostCoverageJobs = {
      ...jobs,
      cells: jobs.cells.filter(([, s, l]) => !(s === 1 && l === largest)),
    };
    const strip = coverageStrip(tests, short, B, null, "hours");
    expect(part(strip, "builds")!.hours).toBeGreaterThanOrEqual(0);
    expect(strip.segments.every((s) => s.value >= 0)).toBe(true);
    expect(strip.clampedHours).toBeGreaterThan(0);
    close(sum(strip.segments.map((s) => s.share)), 1);
    expect(clampWarning(strip)).toMatch(/builds clamped at 0$/);
    expect(
      clampWarning(coverageStrip(tests, jobs, B, null, "hours"))
    ).toBeNull();
  });

  test("without job hours (or with some not covering B) the strip is the repository's test jobs", () => {
    for (const missing of [
      null,
      { ...jobs, to: "2026-11-15" },
      { ...jobs, repo: "pytorch/executorch" },
    ]) {
      const strip = coverageStrip(tests, missing, B, null, "hours");
      expect(strip.base).toBe("repo");
      expect(strip.segments.map((s) => s.part)).toEqual([
        "no_reports",
        "setup_idle",
        "running",
      ]);
      close(sum(strip.segments.map((s) => s.share)), 1);
      close(strip.page, strip.total);
    }
    const strip = coverageStrip(tests, null, B, null, "hours");
    expect(coverageNote(strip, true)).toBe(
      "pytorch/pytorch test-job runner-hours · Nov 12 – 18 (B)"
    );
    // The whole strip is this page: the bracket spans it all.
    expect(bracketLabel(strip)!.full).toMatch(
      /^this page · [\d.]+K h \(100%\)$/
    );
    const lines = details(strip);
    expect(line(lines, "Test files ran")).toMatch(
      /^Test files ran \d+% of this page's time\.$/
    );
    expect(lines).toContain("97% of hours with reports have an owner.");
    // No org: the hours line names no repositories.
    expect(line(lines, "Hours =")).toBe(
      "Hours = job wall time (start → finish) of completed jobs on any runner, GitHub-hosted included."
    );
  });

  test("past 28 days the jobs aren't asked and the caption says why", () => {
    expect(jobsSource(B, END)).toBe("window");
    expect(jobsSource({ from: "2026-10-29", to: "2026-11-04" }, END)).toBe(
      "exact"
    );
    expect(jobsSource({ from: "2026-10-22", to: "2026-11-18" }, END)).toBe(
      "exact"
    ); // 28 days
    expect(jobsSource({ from: "2026-10-21", to: "2026-11-18" }, END)).toBe(
      "too_long"
    ); // 29 days
    const strip = coverageStrip(tests, null, B, null, "hours");
    const long = details(strip, "too_long");
    expect(long[0]).toBe(
      "Org and non-test jobs: ranges up to 28 days for now (a jobs rollup would lift it)."
    );
    expect(long[1]).toMatch(/^Hours = job wall time/);
    expect(details(strip).join(" ")).not.toMatch(/28 days/);
    expect(details(strip, "error")[0]).toBe(
      "Org and non-test jobs could not be loaded."
    );
  });

  test("a workflow scope adds the repository's test jobs outside it, grey, and builds stay the same", () => {
    // Move 40% of every test segment outside the scope.
    const scoped: CostCoverage = {
      ...tests,
      workflows: ["pull", "trunk"],
      cells: tests.cells.flatMap(([d, s, l, h]) => [
        [d, s, l, h * 0.6] as [number, number, number, number],
        [d, 3, l, h * 0.4] as [number, number, number, number],
      ]),
    };
    const all = coverageStrip(tests, jobs, B, null, "hours");
    const strip = coverageStrip(scoped, jobs, B, null, "hours");
    expect(strip.segments.map((s) => s.part)).toEqual(JOB_PARTS);
    const outside = part(strip, "outside_view")!;
    expect(outside.page).toBe(false);
    close(outside.hours, testHoursInB(tests) * 0.4, 3);
    close(strip.page, testHoursInB(tests) * 0.6, 3);
    close(part(strip, "builds")!.hours, part(all, "builds")!.hours, 3);
    close(strip.total, all.total, 3);
    close(sum(strip.segments.map((s) => s.share)), 1);
    // Without job hours, the scoped strip is the repository's test jobs.
    const repo = coverageStrip(scoped, null, B, null, "hours");
    expect(repo.segments.map((s) => s.part)).toEqual([
      "outside_view",
      "no_reports",
      "setup_idle",
      "running",
    ]);
    // The bracket: this page's 60% of the repository's test jobs.
    expect(bracketLabel(repo)).toEqual({
      full: expect.stringMatching(/^this page · [\d.]+K of [\d.]+K h \(60%\)$/),
      short: "this page · 60%",
      tiny: "60%",
    });
  });

  test("$ widths price each day and label; unpriced hours are left out and counted", () => {
    const RATES: Record<string, number> = {
      "mt-l-x86iavx512-16-128": 2,
      "mt-l-x86aavx2-11-41-a10g": 5,
      "mt-l-x86iavx2-8-32": 1,
    };
    const pricer = {
      // Nov 18, the day before today, borrows the last period's rates.
      rate: (label: string, day: string) =>
        day === "2026-11-14" ? null : RATES[label] ?? null,
      dayKind: (day: string) => (day === "2026-11-18" ? "borrowed" : "final"),
    } as unknown as Pricer;
    const strip = coverageStrip(tests, jobs, B, pricer, "usd");
    expect(strip.unit).toBe("usd");
    expect(strip.borrowed).toBe(true);
    // running $ = Σ h × rate over B's days and labels, Nov 14 a gap.
    const running = sum(
      tests.cells
        .filter(
          ([d, s]) =>
            s === 0 &&
            tests.days[d] >= B.from &&
            tests.days[d] <= B.to &&
            tests.days[d] !== "2026-11-14"
        )
        .map(([, , l, h]) => h * (RATES[tests.labels[l]] ?? 0))
    );
    close(part(strip, "running")!.value, running, 3);
    close(sum(strip.segments.map((s) => s.share)), 1);
    // ROCm and GitHub-hosted labels have no rate, nor does any label on Nov 14.
    expect(strip.unpricedHours).toBeGreaterThan(0);
    expect(strip.unpricedLabels.length).toBeGreaterThan(0);
    expect(strip.unpricedLabels.some((l) => l in RATES)).toBe(false);
    close(strip.hours, sum(strip.segments.map((s) => s.hours)), 3);
    expect(strip.unpricedHours).toBeLessThan(strip.hours);
    // The widths are $: a cheap label weighs less than in hours.
    const hours = coverageStrip(tests, jobs, B, pricer, "hours");
    expect(hours.unit).toBe("hours");
    expect(part(strip, "running")!.share).not.toBeCloseTo(
      part(hours, "running")!.share,
      3
    );
    const lines = details(strip);
    expect(line(lines, "Unpriced:")).toMatch(
      /^Unpriced: .* h \(\d+%\) on labels without a rate/
    );
    expect(lines).toContain(
      "≈: some days are priced with the last period's rates."
    );
    // A pricer without a set (this double) names no basis.
    expect(lines).toContain(
      "$ = hours × the rates file's $/h for their day and label."
    );
    expect(line(lines, "Test files ran")).toMatch(/of this page's cost\.$/);
    // Without totals: what isn't tracked, and where totals would go.
    expect(line(lines, "Not tracked yet")).toMatch(
      /A rates file with per-period totals adds them in \$ \(see Format\)\.$/
    );
    expect(bracketLabel(strip)!.full).toMatch(
      /^this page: pytorch\/pytorch test jobs · ≈\$[\d.]+K of ≈\$[\d.]+K \(\d+%\)$/
    );
    expect(coverageNote(strip, true)).toBe(
      "pytorch org CI cost · Nov 12 – 18 (B)"
    );
    // A B whose days have hours but no rates says so, not "No test data".
    const gap = {
      rate: () => null,
      dayKind: () => "gap",
    } as unknown as Pricer;
    const unpriced = coverageStrip(tests, jobs, B, gap, "usd");
    expect(coverageEmpty(unpriced)).toBe(
      "No rates for Nov 12 – 18; switch to Hours to see it."
    );
    expect(bracketLabel(unpriced)).toBeNull();
    // usd without a pricer reads as hours.
    expect(coverageStrip(tests, jobs, B, null, "usd").unit).toBe("hours");
  });

  test("a B before the data has no days and says so", () => {
    const early = { from: "2026-10-20", to: "2026-10-26" };
    const strip = coverageStrip(tests, jobs, early, null, "hours");
    expect(strip.days).toEqual([]);
    expect(strip.total).toBe(0);
    expect(testDays(tests, early)).toBeNull();
    expect(coverageEmpty(strip)).toBe("No test data for Oct 20 – 26.");
    expect(bracketLabel(strip)).toBeNull();
    expect(
      coverageEmpty(coverageStrip(tests, jobs, B, null, "hours"))
    ).toBeNull();
    // A B reaching before the data says how many of its days have any.
    const wide = coverageStrip(
      tests,
      jobs,
      { from: "2026-11-01", to: "2026-11-18" },
      null,
      "hours"
    );
    expect(coverageNote(wide, true)).toBe(
      "pytorch org CI runner-hours · Nov 1 – 18 (B) · 7 of 18 days with data"
    );
  });

  test("the org note, bracket and ⓘ", () => {
    const strip = coverageStrip(tests, jobs, B, null, "hours");
    expect(coverageNote(strip, true)).toBe(
      "pytorch org CI runner-hours · Nov 12 – 18 (B)"
    );
    expect(coverageNote(strip, false)).toBe(
      "pytorch org CI runner-hours · last 7 days"
    );
    // One bracket: this page's amount of the org's, unit once, and its share.
    const label = bracketLabel(strip)!;
    expect(label.full).toMatch(
      /^this page: pytorch\/pytorch test jobs · [\d.]+K of [\d.]+K h \(6\d%\)$/
    );
    expect(label.short).toMatch(/^this page · 6\d%$/);
    expect(label.tiny).toMatch(/^6\d%$/);
    // The ⓘ: the definitions, one fact a line, and what isn't tracked.
    expect(details(strip)).toEqual([
      "Hours = job wall time (start → finish) of completed jobs on any runner, GitHub-hosted included, in 21 pytorch/* repos.",
      expect.stringMatching(/^Test files ran 5\d% of this page's time\.$/),
      "97% of hours with reports have an owner.",
      LEFT_OUT,
    ]);
    expect(strip.bill).toBeNull();
    expect(billLine(strip)).toBeNull();
    expect(LEFT_OUT).toBe(
      "Not tracked yet: node time outside jobs, non-runner AWS spend."
    );
  });

  test("dates and the request hull", () => {
    expect(shortRange({ from: "2026-11-18", to: "2026-11-18" })).toBe("Nov 18");
    expect(shortRange(B)).toBe("Nov 12 – 18");
    expect(shortRange({ from: "2026-10-29", to: "2026-11-04" })).toBe(
      "Oct 29 – Nov 4"
    );
    expect(shortRange({ from: "2026-12-29", to: "2027-01-04" })).toBe(
      "Dec 29 – Jan 4 2027"
    );
    const shown = { from: "2026-10-08", to: "2026-11-18" };
    expect(coverageHull(shown, B)).toEqual(shown);
    expect(
      coverageHull(shown, { from: "2026-10-01", to: "2026-10-07" })
    ).toEqual({ from: "2026-10-01", to: "2026-11-18" });
    expect(coverageHull(null, B)).toEqual(B);
    // Past 400 days, B alone.
    const old = { from: "2025-06-01", to: "2025-06-07" };
    expect(coverageHull(shown, old)).toEqual(old);
  });
});

describe("shares and the $ caption", () => {
  test("whole percents sum to 100 by largest remainder", () => {
    // The live B = Nov 2–8 shares: rounding each gives 22/11/9/17/42 = 101.
    const pcts = wholePercents([0.215, 0.105, 0.087, 0.169, 0.424]);
    expect(pcts.reduce((t, x) => t + x, 0)).toBe(100);
    // Remainders .9, .7, then the .5 tie by order: 22/10/9/17/42.
    expect(pcts).toEqual([22, 10, 9, 17, 42]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
    expect(pctLabel({ pct: 0, share: 0.002 })).toBe("<1%");
    expect(pctLabel({ pct: 7, share: 0.07 })).toBe("7%");
  });

  test("$ caption: days without rates apart from labels without a rate", () => {
    const pricer = {
      rate: (label: string, day: string) =>
        day === "2026-11-14" || label.startsWith("linux.rocm") ? null : 1,
      dayKind: (day: string) => (day === "2026-11-14" ? "gap" : "final"),
    } as unknown as Pricer;
    const strip = coverageStrip(tests, jobs, B, pricer, "usd");
    expect(strip.gapDays).toEqual(["2026-11-14"]);
    expect(strip.gapHours).toBeGreaterThan(0);
    expect(strip.unpricedLabels.every((l) => l.startsWith("linux.rocm"))).toBe(
      true
    );
    expect(line(details(strip), "Unpriced:")).toMatch(
      /^Unpriced: .* h \(\d+%\): .* h on days without rates \(Nov 14\) and .* h on labels without a rate \(e\.g\. linux\.rocm/
    );
    // A B wholly in a gap names the days and no labels.
    const gap = {
      rate: () => null,
      dayKind: () => "gap",
    } as unknown as Pricer;
    expect(
      line(details(coverageStrip(tests, jobs, B, gap, "usd")), "Unpriced:")
    ).toMatch(
      /^Unpriced: .* h \(100%\) on days without rates \(Nov 12 – 18\), left out/
    );
  });

  test("day runs", () => {
    expect(
      dayRuns(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-06"])
    ).toBe("Nov 2 – 4, Nov 6");
  });
});

describe("the strip beside the AWS bill (rates-file totals)", () => {
  // FAKE weekly rates with FAKE totals ($200,000 a week, $100,000 of it
  // runner nodes) on every period; today Nov 20, so Nov 16–19 borrow.
  const file = (name: string) => ({
    name,
    text: readFileSync(join(__dirname, name), "utf8"),
  });
  const weekly = parseRatesFiles([file("rates_FAKE_weekly.json")]);
  const pricer = makePricer(weekly, END);

  test("totals on every priced day: a ghost for the bill outside job time, the bracket against the whole bill", () => {
    const strip = coverageStrip(tests, jobs, B, pricer, "usd");
    const bill = strip.bill!;
    // B's 7 days are all priced (Nov 16–18 borrowed): 7/7 of a week.
    expect([bill.days, bill.of]).toEqual([7, 7]);
    close(bill.aws, 200000, 3);
    close(bill.nodes!, 100000, 3);
    // Every day of B has totals, so the page and the jobs are the strip's.
    close(bill.page, strip.page, 3);
    close(bill.jobs, strip.jobs, 3);
    // The ghost: last, grey, the bill less the jobs, split as the totals
    // give it; the strip's whole is now the bill.
    const ghost = strip.segments[strip.segments.length - 1];
    expect(ghost.part).toBe("outside_jobs");
    expect(ghost.name).toBe("Outside job time");
    expect(ghost.page).toBe(false);
    expect(ghost.hours).toBe(0);
    close(ghost.value, 200000 - strip.jobs, 3);
    close(strip.total, 200000, 3);
    close(strip.outside!.nodes!, 100000 - strip.jobs, 3);
    close(strip.outside!.other!, 100000, 3);
    close(sum(strip.segments.map((s) => s.share)), 1);
    expect(sum(strip.segments.map((s) => s.pct))).toBe(100);
    expect(coverageNote(strip, true)).toBe("total AWS spend · Nov 12 – 18 (B)");
    // The bracket: this page's share of the bill.
    const label = bracketLabel(strip)!;
    expect(label.full).toMatch(
      /^this page: pytorch\/pytorch test jobs · ≈\$\d+(\.\d+)?K of ≈\$200K \(\d+%\)$/
    );
    const pct = Number(/\((\d+)%\)$/.exec(label.full)![1]);
    expect(pct).toBe(Math.round((100 * strip.page) / bill.aws));
    // The grey share stays of the jobs, so the ghost doesn't shrink it.
    expect(greyShare(strip)).toBeCloseTo(
      (part(strip, "other_repos")!.value + part(strip, "builds")!.value) /
        strip.jobs
    );
    expect(greyShare(strip)).toBeGreaterThan(
      part(strip, "other_repos")!.share + part(strip, "builds")!.share
    );
    // The ⓘ: the basis, the ghost's sum and split, where totals come from;
    // nothing "not tracked", no bill line.
    const lines = details(strip);
    expect(line(lines, "$ =")).toBe(
      "$ = hours × the rates file's $/h for their day and label. Rates basis: FAKE synthetic rates for tests: one made-up value per machine class, unrelated to any price list or discount. Totals are FAKE round numbers."
    );
    expect(line(lines, "Outside job time")).toMatch(
      /^Outside job time ≈\$\d+K = total AWS spend ≈\$200K − priced jobs ≈\$[\d.]+K: runner node uptime outside jobs ≈\$[\d.]+K · non-runner AWS spend ≈\$100K\.$/
    );
    expect(outsideSplit(strip)).toMatch(/^: runner node uptime outside jobs /);
    expect(lines).toContain(
      "AWS totals: the rates file's per-period totals, prorated per day; they stay in this tab."
    );
    expect(line(lines, "Not tracked")).toBeUndefined();
    expect(line(lines, "Of ")).toBeUndefined();
    // In hours: no bill, no ghost, the left-out line.
    const hours = coverageStrip(tests, jobs, B, pricer, "hours");
    expect(hours.outside).toBeNull();
    expect(billLine(hours)).toBeNull();
    expect(details(hours)).toContain(LEFT_OUT);
    // Without job hours (the repository base) the bill less its test jobs
    // isn't outside job time: no ghost, the bill line instead.
    const repo = coverageStrip(tests, null, B, pricer, "usd");
    expect(repo.outside).toBeNull();
    expect(repo.segments.map((s) => s.part)).not.toContain("outside_jobs");
    expect(line(details(repo), "Of ")).toMatch(
      /^Of ≈\$200K total AWS spend: runner node uptime ≈\$100K \(50%\) · this page ≈\$[\d.]+K \(\d+%\)\.$/
    );
  });

  test("borrowed days borrow the last period's totals; no day with totals, no bill", () => {
    const json = JSON.parse(file("rates_FAKE_weekly.json").text);
    // Totals on Nov 9–15 only: Nov 16–18 borrow them with its rates.
    json.periods.forEach((p: { totals?: unknown }, i: number) => {
      if (i !== 3) delete p.totals;
    });
    const last = parseRatesFiles([
      { name: "r.json", text: JSON.stringify(json) },
    ]);
    const strip = coverageStrip(tests, jobs, B, makePricer(last, END), "usd");
    expect([strip.bill!.days, strip.bill!.of]).toEqual([7, 7]);
    // Totals on Nov 2–8 only: none of B's days has any.
    json.periods[2].totals = { aws_total: 700 };
    delete json.periods[3].totals;
    const early = parseRatesFiles([
      { name: "e.json", text: JSON.stringify(json) },
    ]);
    const none = coverageStrip(tests, jobs, B, makePricer(early, END), "usd");
    expect(none.bill).toBeNull();
    expect(none.outside).toBeNull();
    expect(billLine(none)).toBeNull();
    expect(line(details(none), "Not tracked yet")).toMatch(/see Format/);
  });

  test("a partial B names its days with totals and draws no ghost; runner node uptime only when every day has it", () => {
    // Totals only on Nov 9–15; Nov 16–18 borrow nothing in a file whose
    // last period has none, so they are priced but without totals.
    const json = JSON.parse(file("rates_FAKE_weekly.json").text);
    json.periods.push({
      valid_from: "2026-11-16",
      valid_through: "2026-11-22",
      rates: json.periods[3].rates,
    });
    json.periods[3].totals = { aws_total: 700000 };
    const set = parseRatesFiles([
      { name: "p.json", text: JSON.stringify(json) },
    ]);
    const strip = coverageStrip(tests, jobs, B, makePricer(set, END), "usd");
    const bill = strip.bill!;
    expect([bill.days, bill.of]).toEqual([4, 7]);
    close(bill.aws, 400000, 3);
    expect(bill.nodes).toBeNull();
    expect(bill.page).toBeLessThan(strip.page);
    expect(bill.jobs).toBeLessThan(strip.total);
    expect(billLine(strip)).toMatch(
      /^Of \$400K total AWS spend \(4 of 7 days\): pytorch org CI jobs \$[\d.]+K \(\d+%\) · this page \$[\d.]+K \(\d+%\)\.$/
    );
    // The ghost needs every priced day's totals: the bill line instead.
    expect(strip.outside).toBeNull();
    close(strip.total, strip.jobs);
    expect(details(strip)).toContain(billLine(strip));
    expect(line(details(strip), "Outside job time")).toBeUndefined();
    // Without job hours the whole is the repository's: no org part.
    const repo = coverageStrip(tests, null, B, makePricer(set, END), "usd");
    expect(billLine(repo)).not.toMatch(/org CI jobs/);
  });
});
