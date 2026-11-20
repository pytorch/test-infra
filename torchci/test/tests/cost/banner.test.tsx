// The coverage banner (components/tests/cost/banner/CoverageBanner.tsx): what it
// draws under SSR from the live answers beside this file, in light and
// dark (the strip, one bracket over this page, the ⓘ's lines, the ghost in
// $ with FAKE totals), and which /coverage/jobs requests it makes as B moves
// (fake timers): none past the fixed window while B is inside it, one after
// B settles outside it, none past 28 days.

import { createTheme, ThemeProvider } from "@mui/material/styles";
import CoverageBanner, {
  CoverageStripView,
} from "components/tests/cost/banner/CoverageBanner";
import {
  addDays,
  type CostCoverage,
  type CostCoverageJobs,
  costCoverageJobsUrl,
  type CoverageBannerProps,
  type DayRange,
  daysIn,
  jobsWindow,
} from "lib/api/tests/cost/contracts";
import { coverageStrip } from "lib/tests/cost/coverage";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import JOBS_JSON from "./coverage_jobs.json";
import TESTS_JSON from "./coverage_tests.json";

const REPO = "pytorch/pytorch";
const END = "2026-11-20";
const tests = TESTS_JSON as unknown as CostCoverage;
const jobs = JOBS_JSON as unknown as CostCoverageJobs;

// The URLs the banner asked for, in order, and what each answers: the
// fixtures for their own URLs; any other /coverage range a synthetic answer
// with a day of data for every day asked, so the banner can slice any B.
const asked: (string | null)[] = [];
function answer(url: string | null): unknown {
  if (url === null) return undefined;
  const params = new URL(url, "http://hud").searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (url.startsWith("/api/tests/cost/coverage/jobs")) {
    return from === jobs.from && to === jobs.to
      ? jobs
      : { ...jobs, from, to, cells: [] };
  }
  if (from === tests.from && to === tests.to) return tests;
  const days = Array.from({ length: daysIn({ from, to }) }, (_, i) =>
    addDays(from, i)
  );
  return {
    ...tests,
    from,
    to,
    days,
    cells: days.map((_, i) => [i, 0, 0, 100]),
  };
}
jest.mock("lib/tests/useApiResource", () => ({
  useApiResource: (url: string | null) => {
    asked.push(url);
    return {
      data: answer(url),
      error: undefined,
      isLoading: false,
      retrying: false,
      retry: () => Promise.resolve(),
    };
  },
}));

const B: DayRange = { from: "2026-11-12", to: "2026-11-18" };
const props = (b: DayRange | null): CoverageBannerProps => ({
  repo: REPO,
  workflows: [],
  b,
  shown: { from: tests.from, to: tests.to },
  end: END,
  unit: "hours",
  pricer: null,
});

// The bracket's markup (its label's texts, longest first) and the ⓘ's
// accessible name (its lines, joined).
function bracket(html: string): string {
  const at = html.indexOf("data-bracket");
  expect(at).toBeGreaterThan(-1);
  const from = html.indexOf(">", at) + 1;
  return text(html.slice(from, html.indexOf("</div></div>", from))).trim();
}
function details(html: string): string {
  const m = /aria-label="About this strip: ([^"]*)"/.exec(html);
  expect(m).not.toBeNull();
  return text(`<b>${m![1]}</b>`).trim();
}

function text(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("coverage banner", () => {
  beforeEach(() => {
    asked.length = 0;
  });

  test("SSR: the title, every part in its block, one bracket over this page and the ⓘ, light and dark", () => {
    for (const mode of ["light", "dark"] as const) {
      const html = renderToStaticMarkup(
        <ThemeProvider theme={createTheme({ palette: { mode } })}>
          <CoverageBanner {...props(B)} />
        </ThemeProvider>
      );
      const words = text(html);
      expect(words).toContain("pytorch org CI runner-hours");
      expect(words).toContain("pytorch org CI runner-hours Nov 12 – 18 (B)");
      for (const name of [
        "Other repos · 20%",
        "Builds, lint, other",
        "No reports",
        "Setup &amp; idle".replace("&amp;", "&"),
        "Active test time · 38%",
      ]) {
        expect(words).toContain(name);
      }
      // One bracket under the blue parts, its label stepping down by width.
      expect(html.match(/data-bracket/g)).toHaveLength(1);
      expect(bracket(html)).toMatch(
        /^this page: pytorch\/pytorch test jobs · [\d.]+K of [\d.]+K h \(6\d%\) this page · 6\d% 6\d%$/
      );
      // The two text lines are gone: their facts are in the ⓘ.
      expect(words).not.toMatch(/This page \(blue\)|Hours = job wall time/);
      const tip = details(html);
      expect(tip).toContain(
        "Hours = job wall time (start → finish) of completed jobs on any runner, GitHub-hosted included, in 21 pytorch/* repos."
      );
      expect(tip).toMatch(/Test files ran 5\d% of this page's time\./);
      expect(tip).toContain("97% of hours with reports have an owner.");
      expect(tip).toContain(
        "Not tracked yet: node time outside jobs, non-runner AWS spend."
      );
      expect(tip).not.toContain("see Format");
      expect(words).not.toContain("total AWS spend");
      expect(words).not.toContain("Outside job time");
      // No popups or coach marks: one strip, labelled for readers.
      expect(html).toContain('role="img"');
      expect(html).toMatch(
        /aria-label="What this page covers: Other repos[^"]*; this page: pytorch\/pytorch test jobs · [\d.]+K of [\d.]+K h \(6\d%\)"/
      );
      expect(words).not.toMatch(/counting/);
      // Its fills follow the mode.
      expect(html).toContain(mode === "dark" ? "#86b6ef" : "#1c5cab");
    }
  });

  test("SSR in $ with FAKE rates carrying totals: a ghost for the rest of the bill, the bracket against it", () => {
    const set = parseRatesFiles([
      {
        name: "rates_FAKE_weekly.json",
        text: readFileSync(join(__dirname, "rates_FAKE_weekly.json"), "utf8"),
      },
    ]);
    const pricer = makePricer(set, END);
    for (const mode of ["light", "dark"] as const) {
      const html = renderToStaticMarkup(
        <ThemeProvider theme={createTheme({ palette: { mode } })}>
          <CoverageBanner {...props(B)} unit="usd" pricer={pricer} />
        </ThemeProvider>
      );
      const words = text(html);
      expect(words).toContain("total AWS spend Nov 12 – 18 (B)");
      // The ghost, last and faint, with its share of the bill.
      expect(words).toMatch(/Outside job time · 5\d%/);
      expect(html).toMatch(/data-part="outside_jobs"/);
      expect(html).toContain("dashed");
      expect(bracket(html)).toMatch(
        /^this page: pytorch\/pytorch test jobs · ≈\$[\d.]+K of ≈\$200K \((\d+)%\) this page · \1% \1%$/
      );
      const tip = details(html);
      expect(tip).toContain("Rates basis: FAKE synthetic rates");
      expect(tip).toMatch(
        /Outside job time ≈\$\d+K = total AWS spend ≈\$200K − priced jobs ≈\$[\d.]+K: runner node uptime outside jobs ≈\$[\d.]+K · non-runner AWS spend ≈\$100K\./
      );
      expect(tip).not.toContain("runner nodes up");
      expect(tip).not.toContain("Not tracked");
    }
    // Without totals: no ghost; the ⓘ names what isn't tracked and where
    // totals go.
    const json = JSON.parse(
      readFileSync(join(__dirname, "rates_FAKE_weekly.json"), "utf8")
    );
    json.periods.forEach((p: { totals?: unknown }) => delete p.totals);
    const bare = makePricer(
      parseRatesFiles([{ name: "r.json", text: JSON.stringify(json) }]),
      END
    );
    const html = renderToStaticMarkup(
      <CoverageBanner {...props(B)} unit="usd" pricer={bare} />
    );
    expect(text(html)).toContain("pytorch org CI cost Nov 12 – 18 (B)");
    expect(text(html)).not.toContain("Outside job time");
    expect(bracket(html)).toMatch(
      /^this page: pytorch\/pytorch test jobs · ≈\$[\d.]+K of ≈\$[\d.]+K \(\d+%\) /
    );
    expect(details(html)).toContain(
      "Not tracked yet: node time outside jobs, non-runner AWS spend. A rates file with per-period totals adds them in $ (see Format)."
    );
    expect(text(html)).not.toContain("total AWS spend");
  });

  test("SSR before the trend answer: a quiet empty strip and no request", () => {
    const html = renderToStaticMarkup(
      <CoverageBanner {...props(null)} end={null} />
    );
    expect(text(html)).toContain("What this page covers");
    expect(html).not.toContain("data-bracket");
    expect(details(html)).toMatch(/^Hours = job wall time/);
    expect(asked.every((u) => u === null)).toBe(true);
  });

  test("B's tests in before end is known: the job hours still counting, not in", () => {
    const html = renderToStaticMarkup(
      <CoverageBanner {...props(B)} end={null} />
    );
    // The counting block, as while the job hours load, not a strip of this
    // repository's test jobs alone.
    expect(text(html)).toContain("counting…");
    expect(html).toContain('data-part="running"');
    expect(
      asked.some((u) => u?.startsWith("/api/tests/cost/coverage/jobs"))
    ).toBe(false);
  });

  test("no B: the last 7 whole days", () => {
    const html = renderToStaticMarkup(<CoverageBanner {...props(null)} />);
    expect(text(html)).toContain("pytorch org CI runner-hours last 7 days");
  });

  test("a B before the data: an empty strip and why, in the bracket's place", () => {
    const early = { from: "2026-10-20", to: "2026-10-26" };
    const html = renderToStaticMarkup(
      <CoverageStripView
        strip={coverageStrip(tests, jobs, early, null, "hours")}
        pending={null}
        dim={false}
        details={["Hours = job wall time"]}
      />
    );
    expect(text(html)).toContain("No test data for Oct 20 – 26.");
    expect(html).not.toContain("data-bracket");
  });

  test("a B inside the jobs window asks nothing past it; ten moves outside ask once", () => {
    jest.useFakeTimers();
    // The synthetic jobs answers hold no hours: the builds clamp warns.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const windowUrl = costCoverageJobsUrl(REPO, jobsWindow(END));
    const jobsUrls = () =>
      new Set(
        asked.filter(
          (u): u is string =>
            u !== null && u.startsWith("/api/tests/cost/coverage/jobs")
        )
      );
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(<CoverageBanner {...props(B)} />);
    });
    // Arrow B through the window: still only the window.
    for (let i = 1; i <= 5; i++) {
      act(() => {
        renderer!.update(
          <CoverageBanner
            {...props({ from: addDays(B.from, -i), to: addDays(B.to, -i) })}
          />
        );
      });
    }
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(Array.from(jobsUrls())).toEqual([windowUrl]);
    // Ten quick moves to weeks before the window, then stillness.
    let last: DayRange = B;
    for (let i = 0; i < 10; i++) {
      last = { from: addDays("2026-10-20", i), to: addDays("2026-10-26", i) };
      act(() => {
        renderer!.update(<CoverageBanner {...props(last)} />);
        jest.advanceTimersByTime(100);
      });
    }
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    const exact = Array.from(jobsUrls()).filter((u) => u !== windowUrl);
    expect(exact).toEqual([costCoverageJobsUrl(REPO, last)]);
    // Past 28 days: no request, and the caption says why.
    act(() => {
      renderer!.update(
        <CoverageBanner {...props({ from: "2026-10-01", to: "2026-11-18" })} />
      );
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(Array.from(jobsUrls()).filter((u) => u !== windowUrl)).toEqual(
      exact
    );
    // The ⓘ's name says so; the strip is the repository's test jobs.
    const words = JSON.stringify(renderer!.toJSON());
    expect(words).toContain("ranges up to 28 days for now");
    expect(words).toContain("pytorch/pytorch test-job runner-hours");
    act(() => renderer!.unmount());
    jest.useRealTimers();
    warn.mockRestore();
  });
});
