import {
  addDays,
  type CostCoverage,
  type CostCoverageJobs,
  costUnit,
  COVERAGE_SEGMENTS,
  type Day,
  type DayRange,
  daysIn,
  JOB_SEGMENTS,
  jobsWindow,
  MAX_JOB_COVERAGE_DAYS,
  MAX_TREND_DAYS,
  type Pricer,
  type Unit,
  within,
} from "lib/api/tests/cost/contracts";
import { hoursLabel, shareLabel, UNIT_NAMES } from "lib/tests/cost/query";
import { dayTotals } from "lib/tests/cost/ratePeriods";

// The coverage banner's arithmetic: one 100% strip of what share of the
// organization's CI runner-hours this page covers, over B's days. Pure, so
// jest checks every share; CoverageBanner draws it.
//
// Left to right: the organization's other repositories and this repository's
// jobs that run no tests (grey, from workflow_job), its test jobs outside the
// workflow scope (grey, only with a scope), then this page (blue, from
// test_cost): test jobs without reports, their setup and idle time, and the
// time test files ran. In $ with rates-file totals on every priced day, a
// faint ghost last: the AWS spend outside that job time.
export const STRIP_PARTS = [
  "other_repos",
  "builds",
  "outside_view",
  "no_reports",
  "setup_idle",
  "running",
  "outside_jobs",
] as const;
export type StripPart = (typeof STRIP_PARTS)[number];

export const PART_NAMES: Record<StripPart, string> = {
  other_repos: "Other repos",
  builds: "Builds, lint, other",
  outside_view: "Outside this view",
  no_reports: "No reports",
  setup_idle: "Setup & idle",
  running: "Active test time",
  outside_jobs: "Outside job time",
};

// What each part is, for its tooltip.
export function partWhat(part: StripPart, repo: string): string {
  switch (part) {
    case "other_repos":
      return `Jobs of the organization's other repositories. Their split into test and other jobs isn't tracked yet.`;
    case "builds":
      return `${repo} jobs that run no tests: builds, lint, docs, infra (its job hours less its test-job hours).`;
    case "outside_view":
      return `${repo} test jobs in workflows outside this view.`;
    case "no_reports":
      return "Test jobs that uploaded no test reports, so their time can't be split by test file or owner.";
    case "setup_idle":
      return "Test-job time with no test file running: checkout, image pull, build download, gaps between files, teardown. Their split isn't tracked yet.";
    case "running":
      return "Time test files held a runner.";
    case "outside_jobs":
      return "Total AWS spend less priced job time: runner node uptime outside jobs and non-runner AWS spend.";
  }
}

const PAGE_PARTS: ReadonlySet<StripPart> = new Set([
  "no_reports",
  "setup_idle",
  "running",
]);
const COVERAGE_PART: Record<(typeof COVERAGE_SEGMENTS)[number], StripPart> = {
  running: "running",
  setup_idle: "setup_idle",
  no_reports: "no_reports",
  out_of_scope: "outside_view",
};

export interface StripSegment {
  part: StripPart;
  name: string;
  hours: number;
  // In the strip's unit: hours, or priced $ (unpriced hours left out).
  value: number;
  share: number; // of the strip's total, 0..1
  pct: number; // share in whole %, the visible parts summing to 100
  page: boolean; // on this page (blue)
}

export interface CoverageStrip {
  repo: string;
  org: string;
  range: DayRange; // B as asked
  days: Day[]; // B's days with test data: the days every part sums
  unit: Unit; // usd only with a pricer
  // org: the strip is the organization's CI; repo: only this repository's
  // test jobs, the organization's jobs being unknown for these days.
  base: "org" | "repo";
  repos: number | null; // repositories with jobs (org base)
  segments: StripSegment[]; // STRIP_PARTS order; only the parts the base holds
  total: number; // the strip's value, the ghost included: what 100% is
  jobs: number; // its jobs' value: total less the ghost
  page: number; // the blue parts' value
  running: number; // test files running, of page
  // Hours of test jobs with reports that have an owner: over the whole
  // /coverage request (owned_h ÷ with_reports_h), not B alone.
  ownerShare: number | null;
  ownerRange: DayRange;
  // $ only: hours without a rate on their day, left out of the widths: on
  // days in no rate period (gapHours, gapDays), the rest on labels their
  // period lacks (the largest of those labels); borrowed: some day of B is
  // priced with the last period's rates (≈).
  unpricedHours: number;
  gapHours: number;
  gapDays: Day[];
  unpricedLabels: string[];
  hours: number; // every part's hours, priced or not
  borrowed: boolean;
  // Hours by which this repository's test jobs exceed its job hours on some
  // label and day (clamped: builds never go negative).
  clampedHours: number;
  // $ only, with a rates file whose periods carry totals: the strip beside
  // the AWS bill. null otherwise.
  bill: BillShare | null;
  // The ghost: org base, $, every priced day with totals, and the bill above
  // its jobs. null otherwise.
  outside: OutsideJobs | null;
  basis: string | null; // $ only: the rates file's "basis"
}

// The AWS bill outside the strip's job time, as the totals give it: of it,
// runner node uptime outside jobs (runner_nodes less the jobs, floored at
// 0) and non-runner AWS spend (aws_total less runner_nodes); both null
// without runner_nodes.
export interface OutsideJobs {
  value: number;
  nodes: number | null;
  other: number | null;
}

// The strip's $ beside the rates file's per-period totals, prorated per day
// and summed over B's priced days whose period has them (days of them, of
// all priced days), so every amount spans the same days.
export interface BillShare {
  aws: number; // the whole AWS bill
  nodes: number | null; // of it, runner node uptime; null unless every day has it
  page: number; // this page (the blue parts)
  jobs: number; // the strip's whole: org CI jobs, or the repository's test jobs
  days: number;
  of: number;
}

// Where the banner reads B's job hours from: the fixed window the page asks
// once, an exact request (B outside it, up to 28 days), or nowhere (longer).
// need = the days of B with test data, so days before the data never ask.
export function jobsSource(
  need: DayRange,
  end: Day
): "window" | "exact" | "too_long" {
  if (within(need, jobsWindow(end))) return "window";
  return daysIn(need) <= MAX_JOB_COVERAGE_DAYS ? "exact" : "too_long";
}

// B's days that the test answer holds, as one range: what the job hours must
// cover. null when B has no test data.
export function testDays(tests: CostCoverage, b: DayRange): DayRange | null {
  const days = tests.days.filter((d) => d >= b.from && d <= b.to);
  return days.length === 0
    ? null
    : { from: days[0], to: days[days.length - 1] };
}

// The strip for B. jobs null (or not covering B's days with test data):
// only this repository's test jobs, as 100% of them. With a pricer and unit
// usd, every part is priced per day and label (pricer.rate) and the widths
// are $; hours without a rate on their day are left out and counted.
export function coverageStrip(
  tests: CostCoverage,
  jobs: CostCoverageJobs | null,
  b: DayRange,
  pricer: Pricer | null,
  unit: Unit
): CoverageStrip {
  const priced = unit === "usd" && pricer !== null;
  const dayOf = new Map<number, Day>();
  tests.days.forEach((d, i) => {
    if (d >= b.from && d <= b.to) dayOf.set(i, d);
  });
  const days = Array.from(dayOf.values()).sort();
  const need =
    days.length === 0 ? null : { from: days[0], to: days[days.length - 1] };
  const usable =
    jobs !== null &&
    need !== null &&
    jobs.repo === tests.repo &&
    within(need, { from: jobs.from, to: jobs.to });

  const hours = new Map<StripPart, number>();
  const values = new Map<StripPart, number>();
  // $ by day, of the page and of every part, for the bill's days.
  const dayPage = new Map<Day, number>();
  const dayAll = new Map<Day, number>();
  const unpriced = new Map<string, number>();
  let unpricedHours = 0;
  let gapHours = 0;
  const gapDays = new Set<Day>();
  let allHours = 0;
  const add = (part: StripPart, label: string, day: Day, h: number) => {
    if (h <= 0) return;
    hours.set(part, (hours.get(part) ?? 0) + h);
    allHours += h;
    if (!priced) {
      values.set(part, (values.get(part) ?? 0) + h);
      return;
    }
    const rate = pricer.rate(label, day);
    if (rate === null) {
      unpricedHours += h;
      if (pricer.dayKind(day) === "gap") {
        gapHours += h;
        gapDays.add(day);
      } else {
        unpriced.set(label, (unpriced.get(label) ?? 0) + h);
      }
    } else {
      const v = h * rate;
      values.set(part, (values.get(part) ?? 0) + v);
      dayAll.set(day, (dayAll.get(day) ?? 0) + v);
      if (PAGE_PARTS.has(part)) dayPage.set(day, (dayPage.get(day) ?? 0) + v);
    }
  };

  // Every test-job hour of the repository by day and label, any scope: what
  // its job hours are reduced by to leave builds, lint and other jobs.
  const testHours = new Map<string, number>();
  for (const [di, si, li, h] of tests.cells) {
    const day = dayOf.get(di);
    if (day === undefined) continue;
    const label = tests.labels[li];
    add(COVERAGE_PART[COVERAGE_SEGMENTS[si]], label, day, h);
    const key = `${day}|${label}`;
    testHours.set(key, (testHours.get(key) ?? 0) + h);
  }

  let clampedHours = 0;
  if (usable) {
    const inDays = new Set(days);
    const repoAll = new Map<string, number>();
    for (const [di, si, li, h] of jobs.cells) {
      const day = addDays(jobs.from, di);
      if (!inDays.has(day)) continue;
      const label = jobs.labels[li];
      if (JOB_SEGMENTS[si] === "other_repos") {
        add("other_repos", label, day, h);
      } else {
        const key = `${day}|${label}`;
        repoAll.set(key, (repoAll.get(key) ?? 0) + h);
      }
    }
    for (const [key, h] of repoAll) {
      const rest = h - (testHours.get(key) ?? 0);
      const bar = key.indexOf("|");
      add("builds", key.slice(bar + 1), key.slice(0, bar), rest);
    }
    // Test hours on a day and label with fewer (or no) job hours: the two
    // tables disagree there; builds stay at 0 rather than go negative.
    for (const [key, h] of testHours) {
      const rest = (repoAll.get(key) ?? 0) - h;
      if (rest < 0) clampedHours -= rest;
    }
  }

  const scoped =
    tests.workflows.length > 0 || (hours.get("outside_view") ?? 0) > 0;
  const parts: StripPart[] = STRIP_PARTS.filter((part) =>
    part === "other_repos" || part === "builds"
      ? usable
      : part === "outside_view"
      ? scoped
      : part !== "outside_jobs"
  );
  const jobsTotal = parts.reduce((sum, p) => sum + (values.get(p) ?? 0), 0);
  const bill = priced ? billShare(pricer, days, dayPage, dayAll) : null;
  const outside =
    usable && bill !== null && bill.days === bill.of ? outsideJobs(bill) : null;
  if (outside !== null) {
    values.set("outside_jobs", outside.value);
    parts.push("outside_jobs");
  }
  const total = jobsTotal + (outside?.value ?? 0);
  const shares = parts.map((p) =>
    total > 0 ? (values.get(p) ?? 0) / total : 0
  );
  const pcts = wholePercents(shares);
  const segments = parts.map((part, i) => {
    const value = values.get(part) ?? 0;
    return {
      part,
      name: PART_NAMES[part],
      hours: hours.get(part) ?? 0,
      value,
      share: shares[i],
      pct: pcts[i],
      page: PAGE_PARTS.has(part),
    };
  });
  return {
    repo: tests.repo,
    org: jobs?.org ?? tests.repo.split("/")[0],
    range: b,
    days,
    unit: priced ? "usd" : "hours",
    base: usable ? "org" : "repo",
    repos: usable ? jobs.repos : null,
    segments,
    total,
    jobs: jobsTotal,
    page: segments.reduce((sum, s) => sum + (s.page ? s.value : 0), 0),
    running: values.get("running") ?? 0,
    ownerShare:
      tests.with_reports_h > 0 ? tests.owned_h / tests.with_reports_h : null,
    ownerRange: { from: tests.from, to: tests.to },
    unpricedHours,
    gapHours,
    gapDays: Array.from(gapDays).sort(),
    unpricedLabels: Array.from(unpriced)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([label]) => label),
    hours: allHours,
    borrowed: priced && days.some((d) => pricer.dayKind(d) === "borrowed"),
    clampedHours,
    bill,
    outside,
    basis: priced ? pricer.set?.basis ?? null : null,
  };
}

function outsideJobs(bill: BillShare): OutsideJobs | null {
  const value = bill.aws - bill.jobs;
  if (value <= 0) return null;
  return {
    value,
    nodes: bill.nodes === null ? null : Math.max(0, bill.nodes - bill.jobs),
    other: bill.nodes === null ? null : bill.aws - bill.nodes,
  };
}

function billShare(
  pricer: Pricer,
  days: readonly Day[],
  dayPage: ReadonlyMap<Day, number>,
  dayAll: ReadonlyMap<Day, number>
): BillShare | null {
  let of = 0;
  let n = 0;
  let aws = 0;
  let nodes: number | null = 0;
  let page = 0;
  let jobs = 0;
  for (const day of days) {
    if (pricer.dayKind(day) === "gap") continue;
    of += 1;
    const t = dayTotals(pricer, day);
    if (t === null) continue;
    n += 1;
    aws += t.aws_total;
    nodes =
      nodes === null || t.runner_nodes === null ? null : nodes + t.runner_nodes;
    page += dayPage.get(day) ?? 0;
    jobs += dayAll.get(day) ?? 0;
  }
  return n === 0 ? null : { aws, nodes, page, jobs, days: n, of };
}

// Shares (0..1) as whole percents that sum to 100 (largest remainder), so
// 21.5 / 10.5 / 8.7 / 16.9 / 42.3 reads 22 / 10 / 9 / 17 / 42, not 101.
export function wholePercents(shares: readonly number[]): number[] {
  const raw = shares.map((s) => s * 100);
  const sum = raw.reduce((t, x) => t + x, 0);
  if (sum <= 0) return raw.map(() => 0);
  const out = raw.map((x) => Math.floor(x));
  let left = Math.round(sum) - out.reduce((t, x) => t + x, 0);
  const order = raw
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((p, q) => q.rest - p.rest || p.i - q.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

// A visible part's share as its label writes it: "<1%" for a sliver that
// rounds to 0, else the whole percent.
export function pctLabel(s: Pick<StripSegment, "pct" | "share">): string {
  return s.pct === 0 && s.share > 0 ? "<1%" : `${s.pct}%`;
}

// Days as runs: "Nov 2 – 8", "Nov 2 – 4, Nov 6".
export function dayRuns(days: readonly Day[]): string {
  const runs: DayRange[] = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last !== undefined && addDays(last.to, 1) === day) last.to = day;
    else runs.push({ from: day, to: day });
  }
  return runs.map(shortRange).join(", ");
}

// The console warning for a strip whose builds were clamped by more than 1%
// of its hours (test_cost and workflow_job disagree on some day and label);
// null otherwise. The banner logs it once per strip.
export function clampWarning(strip: CoverageStrip): string | null {
  if (strip.clampedHours <= 0.01 * Math.max(1, strip.hours)) return null;
  return `coverage: ${Math.round(
    strip.clampedHours
  )} test-job hours exceed the job hours of their day and label; builds clamped at 0`;
}

// The share of the grey parts the jobs fill (other repos, builds): kept
// from the last strip with job hours, so a strip waiting on them keeps its
// shape. A first guess before any (about a third).
export const GREY_GUESS = 0.33;
// Of the jobs alone, so the ghost doesn't shrink it.
export function greyShare(strip: CoverageStrip): number | null {
  if (strip.base !== "org" || strip.jobs <= 0) return null;
  return (
    strip.segments
      .filter((s) => s.part === "other_repos" || s.part === "builds")
      .reduce((sum, s) => sum + s.value, 0) / strip.jobs
  );
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function monthDay(day: Day): [string, number] {
  return [MONTHS[Number(day.slice(5, 7)) - 1], Number(day.slice(8, 10))];
}

// A range of UTC days in words: "Nov 18", "Nov 12 – 18", "Oct 29 – Nov 4",
// read as text so no time zone moves a day.
export function shortRange(range: DayRange): string {
  const [m1, d1] = monthDay(range.from);
  const [m2, d2] = monthDay(range.to);
  if (range.from === range.to) return `${m1} ${d1}`;
  const year =
    range.from.slice(0, 4) === range.to.slice(0, 4)
      ? ""
      : ` ${range.to.slice(0, 4)}`;
  return m1 === m2 && !year
    ? `${m1} ${d1} – ${d2}`
    : `${m1} ${d1} – ${m2} ${d2}${year}`;
}

// The days the banner covers when no B is set: the last 7 whole days.
export function defaultBannerRange(end: Day): DayRange {
  return { from: addDays(end, -7), to: addDays(end, -1) };
}

// The /coverage request's range: the hull of the bars shown and B, so B can
// move within the chart without a request; B alone when the hull would pass
// the endpoint's 400 days (a B far from the bars).
export function coverageHull(shown: DayRange | null, b: DayRange): DayRange {
  if (shown === null) return b;
  const hull = {
    from: shown.from < b.from ? shown.from : b.from,
    to: shown.to > b.to ? shown.to : b.to,
  };
  return daysIn(hull) > MAX_TREND_DAYS ? b : hull;
}

// Where the banner's job hours stand: in (ok), on their way, B too long for
// workflow_job (a jobs rollup would lift it), or failed.
export type JobsState = "ok" | "loading" | "too_long" | "error";

// Two amounts read side by side at one precision (3 significant digits),
// e.g. "≈$95.7K of ≈$200K", never one rounded finer than the other.
const SIG3 = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumSignificantDigits: 3,
});
function sig3(strip: CoverageStrip, value: number): string {
  const n = value < 1000 ? value.toFixed(0) : SIG3.format(value);
  const text = strip.unit === "usd" ? `$${n}` : n;
  return strip.borrowed && strip.unit === "usd" ? `≈${text}` : text;
}
function pairAmount(strip: CoverageStrip, value: number): string {
  const text = sig3(strip, value);
  return strip.unit === "usd" ? text : `${text} h`;
}

// The banner's title: what 100% is ("pytorch org CI runner-hours"); the
// bracket says which part of it this page is.
export function coverageWhat(strip: CoverageStrip): string {
  const unit = UNIT_NAMES[costUnit(strip.unit)];
  return strip.outside !== null
    ? "total AWS spend"
    : strip.base === "org"
    ? `${strip.org} org CI ${unit}`
    : `${strip.repo} test-job ${unit}`;
}

// The days the strip covers, after the title: "Nov 12 – 18 (B)".
export function coverageWhen(strip: CoverageStrip, isB: boolean): string {
  return coverageNote(strip, isB).slice(coverageWhat(strip).length + 3);
}

// The banner's title note: what 100% is and over which days.
export function coverageNote(strip: CoverageStrip, isB: boolean): string {
  const what = coverageWhat(strip);
  const asked = daysIn(strip.range);
  const partial =
    strip.days.length > 0 && strip.days.length < asked
      ? ` · ${strip.days.length} of ${asked} days with data`
      : "";
  return `${what} · ${
    isB ? `${shortRange(strip.range)} (B)` : "last 7 days"
  }${partial}`;
}

// Why the strip is empty, in the bracket's place: no test data for B, or in
// $ hours on days the rates file leaves unpriced (a gap). null otherwise.
export function coverageEmpty(strip: CoverageStrip): string | null {
  if (strip.days.length > 0 && strip.total > 0) return null;
  return strip.days.length > 0 && strip.unit === "usd" && strip.hours > 0
    ? `No rates for ${shortRange(strip.range)}; switch to Hours to see it.`
    : `No test data for ${shortRange(strip.range)}.`;
}

// The bracket under the blue parts: this page's amount of the strip's whole
// and its share, then shorter as its span narrows ("this page · 67%",
// "67%"). null when the strip is empty.
export function bracketLabel(
  strip: CoverageStrip
): { full: string; short: string; tiny: string } | null {
  if (coverageEmpty(strip) !== null) return null;
  const pct = shareLabel(strip.page / strip.total);
  const amounts =
    strip.page < strip.total
      ? `${sig3(strip, strip.page)} of ${pairAmount(strip, strip.total)}`
      : pairAmount(strip, strip.total);
  return {
    full: `this page${
      strip.base === "org" ? `: ${strip.repo} test jobs` : ""
    } · ${amounts} (${pct})`,
    short: `this page · ${pct}`,
    tiny: pct,
  };
}

// What the strip leaves out while the rates file carries no totals (or the
// page is in hours).
export const LEFT_OUT =
  "Not tracked yet: node time outside jobs, non-runner AWS spend.";

// Where the rates-file totals come from, beside any amount drawn from them.
export const TOTALS_NOTE =
  "AWS totals: the rates file's per-period totals, prorated per day; they stay in this tab.";

// The ghost's two parts, as the totals give them: ": runner node uptime
// outside jobs ≈$4.33K · non-runner AWS spend ≈$100K"; "" without
// runner_nodes or a ghost.
export function outsideSplit(strip: CoverageStrip): string {
  const o = strip.outside;
  if (o === null || o.nodes === null || o.other === null) return "";
  return `: runner node uptime outside jobs ${pairAmount(
    strip,
    o.nodes
  )} · non-runner AWS spend ${pairAmount(strip, o.other)}`;
}

// In $ with totals but no ghost (some priced day without totals, or the
// repository base), the strip beside the AWS bill; null otherwise.
export function billLine(strip: CoverageStrip): string | null {
  const b = strip.unit === "usd" ? strip.bill : null;
  if (b === null || b.aws <= 0) return null;
  // Largest to smallest, each a share of the bill.
  const of = (v: number) =>
    `${pairAmount(strip, v)} (${shareLabel(v / b.aws)})`;
  const days = b.days < b.of ? ` (${b.days} of ${b.of} days)` : "";
  const parts = [
    b.nodes === null ? null : `runner node uptime ${of(b.nodes)}`,
    strip.base === "org" ? `${strip.org} org CI jobs ${of(b.jobs)}` : null,
    `this page ${of(b.page)}`,
  ];
  return `Of ${pairAmount(strip, b.aws)} total AWS spend${days}: ${parts
    .filter((p): p is string => p !== null)
    .join(" · ")}.`;
}

// The ⓘ beside the strip, one fact a line: why the grey parts are missing,
// what an hour (and a $) is, how much of the page test files ran, owners,
// the ghost or the bill, what is unpriced, and what isn't tracked.
export function coverageDetails(
  strip: CoverageStrip | null,
  jobs: JobsState
): string[] {
  const lines: string[] = [];
  if (jobs === "too_long") {
    lines.push(
      "Org and non-test jobs: ranges up to 28 days for now (a jobs rollup would lift it)."
    );
  } else if (jobs === "error") {
    lines.push("Org and non-test jobs could not be loaded.");
  }
  const repos =
    strip?.base === "org" && strip.repos !== null
      ? `, in ${strip.repos} ${strip.org}/* repos`
      : "";
  lines.push(
    `Hours = job wall time (start → finish) of completed jobs on any runner, GitHub-hosted included${repos}.`
  );
  if (strip === null) return lines;
  const usd = strip.unit === "usd";
  if (usd) {
    lines.push(
      `$ = hours × the rates file's $/h for their day and label.${
        strip.basis === null ? "" : ` Rates basis: ${strip.basis}`
      }`
    );
  }
  if (strip.page > 0) {
    lines.push(
      `Test files ran ${shareLabel(
        strip.running / strip.page
      )} of this page's ${usd ? "cost" : "time"}.`
    );
  }
  if (strip.ownerShare !== null) {
    const shown =
      strip.ownerRange.from === strip.range.from &&
      strip.ownerRange.to === strip.range.to
        ? ""
        : " (over the days shown)";
    lines.push(
      `${shareLabel(
        strip.ownerShare
      )} of hours with reports have an owner${shown}.`
    );
  }
  const o = strip.outside;
  const bill = billLine(strip);
  if (o !== null) {
    lines.push(
      `Outside job time ${pairAmount(
        strip,
        o.value
      )} = total AWS spend ${pairAmount(
        strip,
        strip.total
      )} − priced jobs ${pairAmount(strip, strip.jobs)}${outsideSplit(strip)}.`,
      TOTALS_NOTE
    );
  } else if (bill !== null) {
    lines.push(bill, TOTALS_NOTE);
  }
  if (usd && strip.unpricedHours > 0) {
    // Days in no rate period are unpriced whatever their labels: name the
    // days, and list example labels only for labels their period lacks.
    const labelHours = strip.unpricedHours - strip.gapHours;
    const where = [
      strip.gapHours > 0
        ? `${
            labelHours >= 0.5 ? `${hoursLabel(strip.gapHours)} h ` : ""
          }on days without rates (${dayRuns(strip.gapDays)})`
        : null,
      labelHours >= 0.5
        ? `${
            strip.gapHours > 0 ? `${hoursLabel(labelHours)} h ` : ""
          }on labels without a rate${
            strip.unpricedLabels.length > 0
              ? ` (e.g. ${strip.unpricedLabels.join(", ")})`
              : ""
          }`
        : null,
    ].filter((w): w is string => w !== null);
    lines.push(
      `Unpriced: ${hoursLabel(strip.unpricedHours)} h (${shareLabel(
        strip.unpricedHours / Math.max(strip.hours, 1)
      )})${where.length > 1 ? ":" : ""} ${where.join(
        " and "
      )}, left out of the widths.`
    );
  }
  if (usd && strip.borrowed) {
    lines.push("≈: some days are priced with the last period's rates.");
  }
  if (o === null && bill === null) {
    lines.push(
      usd
        ? `${LEFT_OUT} A rates file with per-period totals adds them in $ (see Format).`
        : LEFT_OUT
    );
  }
  return lines;
}
