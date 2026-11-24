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
  partWhat,
  pctLabel,
  segmentLabels,
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
// The ⓘ's lines, three short ones at most, and the line starting with a
// prefix.
const details = (
  strip: ReturnType<typeof coverageStrip>,
  jobs: Parameters<typeof coverageDetails>[1] = "ok"
) => {
  const lines = coverageDetails(strip, jobs);
  expect(lines.length).toBeLessThanOrEqual(3);
  return lines;
};
const HOURS_LINE =
  "Hours = wall time of completed jobs on any runner, GitHub-hosted included.";
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
    expect(details(strip)).toEqual([HOURS_LINE, LEFT_OUT]);
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
      "Other repos and builds show for a B of up to 28 days."
    );
    expect(long[1]).toBe(HOURS_LINE);
    expect(details(strip).join(" ")).not.toMatch(/28 days/);
    expect(details(strip, "error")[0]).toBe(
      "Other repos and builds could not be loaded."
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
      rate: (label: string, day: string) =>
        day === "2026-11-14" ? null : RATES[label] ?? null,
      dayKind: () => "final",
    } as unknown as Pricer;
    const strip = coverageStrip(tests, jobs, B, pricer, "usd");
    expect(strip.unit).toBe("usd");
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
    close(strip.hours, sum(strip.segments.map((s) => s.hours)), 3);
    expect(strip.unpricedHours).toBeLessThan(strip.hours);
    // The widths are $: a cheap label weighs less than in hours.
    const hours = coverageStrip(tests, jobs, B, pricer, "hours");
    expect(hours.unit).toBe("hours");
    expect(part(strip, "running")!.share).not.toBeCloseTo(
      part(hours, "running")!.share,
      3
    );
    // What a $ is, the unpriced hours, and without totals what the strip
    // leaves out and where totals would go.
    expect(details(strip)).toEqual([
      "$ = hours × the rates file's $/h for their day and label.",
      expect.stringMatching(
        /^Unpriced: .* h \(\d+%\) on labels without a rate, left out of the widths\.$/
      ),
      `${LEFT_OUT} Rates-file totals add them (see Format).`,
    ]);
    expect(bracketLabel(strip)!.full).toMatch(
      /^this page: pytorch\/pytorch test jobs · \$[\d.]+K of \$[\d.]+K \(\d+%\)$/
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
    // The ⓘ: what an hour is (no repository count: the jobs window isn't
    // B), and what the strip leaves out.
    expect(details(strip)).toEqual([HOURS_LINE, LEFT_OUT]);
    expect(strip.bill).toBeNull();
    expect(billLine(strip)).toBeNull();
    expect(LEFT_OUT).toBe(
      "Left out: runner node time outside jobs, non-runner AWS spend."
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

  test("$ caption: days not in the rates file apart from labels without a rate", () => {
    const pricer = {
      rate: (label: string, day: string) =>
        day === "2026-11-14" || label.startsWith("linux.rocm") ? null : 1,
      dayKind: (day: string) => (day === "2026-11-14" ? "gap" : "final"),
    } as unknown as Pricer;
    const strip = coverageStrip(tests, jobs, B, pricer, "usd");
    expect(strip.gapDays).toEqual(["2026-11-14"]);
    expect(strip.gapHours).toBeGreaterThan(0);
    expect(line(details(strip), "Unpriced:")).toMatch(
      /^Unpriced: .* h \(\d+%\) on days not in the rates file \(Nov 14\) and labels without a rate, left out of the widths\.$/
    );
    // A B wholly in a gap names the days and no labels.
    const gap = {
      rate: () => null,
      dayKind: () => "gap",
    } as unknown as Pricer;
    expect(
      line(details(coverageStrip(tests, jobs, B, gap, "usd")), "Unpriced:")
    ).toMatch(
      /^Unpriced: .* h \(100%\) on days not in the rates file \(Nov 12 – 18\), left out/
    );
  });

  test("a narrow segment keeps a name before only its share", () => {
    const strip = coverageStrip(tests, jobs, B, null, "hours");
    const builds = part(strip, "builds")!;
    const pct = pctLabel(builds);
    expect(segmentLabels(builds, false)).toEqual([
      `Builds, lint, other · ${pct}`,
      `Builds · ${pct}`,
      "Builds",
      pct,
    ]);
    const none = part(strip, "no_reports")!;
    expect(segmentLabels(none, false)).toEqual([
      `No reports · ${pctLabel(none)}`,
      "No reports",
      pctLabel(none),
    ]);
    // While the job hours count: names only.
    expect(segmentLabels(builds, true)).toEqual([
      "Builds, lint, other",
      "Builds",
    ]);
    expect(segmentLabels(none, true)).toEqual(["No reports"]);
    // Builds is every job not named as a test job, not "no tests".
    expect(partWhat("builds", "pytorch/pytorch")).toBe(
      'pytorch/pytorch jobs not named "test (…)": builds, lint, docs, infra, and any test jobs named otherwise.'
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
  // runner nodes) on every period. The file ends Nov 15, so B's Nov 16–18
  // have no rates; carried, the file lists Nov 16–22 too, with the last
  // week's rates and totals, as a generator extrapolating it would.
  const file = (name: string) => ({
    name,
    text: readFileSync(join(__dirname, name), "utf8"),
  });
  const weeklyJson = JSON.parse(file("rates_FAKE_weekly.json").text);
  const weekly = parseRatesFiles([file("rates_FAKE_weekly.json")]);
  const carried = parseRatesFiles([
    {
      name: "rates_FAKE_carried.json",
      text: JSON.stringify({
        ...weeklyJson,
        periods: [
          ...weeklyJson.periods,
          {
            ...weeklyJson.periods[3],
            valid_from: "2026-11-16",
            valid_through: "2026-11-22",
          },
        ],
      }),
    },
  ]);
  const pricer = makePricer(carried);

  test("the days after the file's end are a gap: left out of the bill, the $ and the ghost's days, and named", () => {
    const strip = coverageStrip(tests, jobs, B, makePricer(weekly), "usd");
    expect(strip.gapDays).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(strip.gapHours).toBeGreaterThan(0);
    // The bill spans the 4 priced days only, each with its totals.
    const bill = strip.bill!;
    expect([bill.days, bill.of]).toEqual([4, 4]);
    close(bill.aws, (4 * 200000) / 7, 3);
    // Less $ than with the carried file, which prices Nov 16–18 too.
    const full = coverageStrip(tests, jobs, B, pricer, "usd");
    expect(strip.page).toBeLessThan(full.page);
    expect(line(details(strip), "Unpriced:")).toMatch(
      /^Unpriced: .* h \(\d+%\) on days not in the rates file \(Nov 16 – 18\)/
    );
    expect(details(strip).join(" ")).not.toMatch(/≈|last period/);
  });

  test("totals on every priced day: a ghost for the bill outside job time, the bracket against the whole bill", () => {
    const strip = coverageStrip(tests, jobs, B, pricer, "usd");
    const bill = strip.bill!;
    // B's 7 days are all listed (Nov 16–18 in the carried week): 7/7.
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
      /^this page: pytorch\/pytorch test jobs · \$\d+(\.\d+)?K of \$200K \(\d+%\)$/
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
    // The ⓘ: what a $ is and where the totals come from (the ghost's own
    // hover splits it); nothing left out, no bill line, no basis (the rates
    // key names it).
    const lines = details(strip);
    expect(line(lines, "$ =")).toBe(
      "$ = hours × the rates file's $/h for their day and label."
    );
    expect(lines.join(" ")).not.toMatch(/basis|Outside job time/);
    expect(outsideSplit(strip)).toMatch(/^: runner node uptime outside jobs /);
    expect(lines).toContain(
      "Total AWS spend: the rates file's per-period totals, prorated per day."
    );
    expect(line(lines, "Left out")).toBeUndefined();
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
      /^Of \$200K total AWS spend: runner nodes 50%, this page \d+%\.$/
    );
  });

  test("each day takes its own period's totals, never a neighbour's; no day with totals, no bill", () => {
    const json = JSON.parse(file("rates_FAKE_weekly.json").text);
    // Totals on Nov 9–15 only: B's Nov 12–15 have them, and Nov 16–18,
    // after the file, have neither rates nor totals.
    json.periods.forEach((p: { totals?: unknown }, i: number) => {
      if (i !== 3) delete p.totals;
    });
    const last = parseRatesFiles([
      { name: "r.json", text: JSON.stringify(json) },
    ]);
    const strip = coverageStrip(tests, jobs, B, makePricer(last), "usd");
    expect([strip.bill!.days, strip.bill!.of]).toEqual([4, 4]);
    // Totals on Nov 2–8 only: none of B's days has any.
    json.periods[2].totals = { aws_total: 700 };
    delete json.periods[3].totals;
    const early = parseRatesFiles([
      { name: "e.json", text: JSON.stringify(json) },
    ]);
    const none = coverageStrip(tests, jobs, B, makePricer(early), "usd");
    expect(none.bill).toBeNull();
    expect(none.outside).toBeNull();
    expect(billLine(none)).toBeNull();
    expect(line(details(none), "Left out")).toMatch(/see Format/);
  });

  test("a partial B names its days with totals and draws no ghost; runner node uptime only when every day has it", () => {
    // Totals only on Nov 9–15; the file lists Nov 16–22 without totals, so
    // those days are priced but have none.
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
    const strip = coverageStrip(tests, jobs, B, makePricer(set), "usd");
    const bill = strip.bill!;
    expect([bill.days, bill.of]).toEqual([4, 7]);
    close(bill.aws, 400000, 3);
    expect(bill.nodes).toBeNull();
    expect(bill.page).toBeLessThan(strip.page);
    expect(bill.jobs).toBeLessThan(strip.total);
    expect(billLine(strip)).toMatch(
      /^Of \$400K total AWS spend \(4 of 7 days\): pytorch org CI jobs \d+%, this page \d+%\.$/
    );
    // The ghost needs every priced day's totals: the bill line instead.
    expect(strip.outside).toBeNull();
    close(strip.total, strip.jobs);
    expect(details(strip)).toContain(billLine(strip));
    expect(line(details(strip), "Outside job time")).toBeUndefined();
    // Without job hours the whole is the repository's: no org part.
    const repo = coverageStrip(tests, null, B, makePricer(set), "usd");
    expect(billLine(repo)).not.toMatch(/org CI jobs/);
  });
});
