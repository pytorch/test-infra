import {
  allPassed,
  clockLabel,
  commitCrumbs,
  commitPullRequestNumber,
  CommitTestCounts,
  COUNT_FIGURE_MIN_SIZE,
  COUNT_FIGURE_SIZE,
  COUNT_GAP,
  countGap,
  fittingCountSize,
  headline,
  problemHue,
  pullRequestUrl,
  shareLabel,
  shortSha,
  statusWord,
  SUMMARY_TEXT_SIZE,
  summaryStatuses,
  timeRangeLabel,
  whenLabel,
} from "lib/tests/commit";

describe("headline", () => {
  it("takes the pull request off the end and sets backticks as code", () => {
    expect(
      headline(
        "dynamo: Handle symbolic truthiness of user-defined objects in `not` (#202376)"
      )
    ).toEqual({
      pieces: [
        {
          kind: "text",
          text: "dynamo: Handle symbolic truthiness of user-defined objects in ",
        },
        { kind: "code", text: "not" },
      ],
      pullRequest: 202376,
    });
  });
  it("links a pull request named inside a revert's title", () => {
    expect(
      headline(
        'Revert "[FSDP2] Add public set_unshard_in_current_stream (#202343)"'
      )
    ).toEqual({
      pieces: [
        {
          kind: "text",
          text: 'Revert "[FSDP2] Add public set_unshard_in_current_stream (',
        },
        { kind: "pr", number: 202343, text: "#202343" },
        { kind: "text", text: ')"' },
      ],
      pullRequest: null,
    });
  });
  it("reads only the first line and leaves plain text alone", () => {
    expect(headline("Fix a thing\n\nLong description (#1)")).toEqual({
      pieces: [{ kind: "text", text: "Fix a thing" }],
      pullRequest: null,
    });
    expect(headline("Issue #12 and C#")).toEqual({
      pieces: [
        { kind: "text", text: "Issue " },
        { kind: "pr", number: 12, text: "#12" },
        { kind: "text", text: " and C#" },
      ],
      pullRequest: null,
    });
  });
});

describe("time labels", () => {
  // Local time on this machine: the expectations are built with the same
  // zone the labels use.
  const local = (iso: string) => new Date(iso);
  const hour12 = (date: Date) => ((date.getHours() + 11) % 12) + 1;
  const half = (date: Date) => (date.getHours() < 12 ? "am" : "pm");
  const minutes = (date: Date) => String(date.getMinutes()).padStart(2, "0");
  it("say when something happened and when an attempt started", () => {
    const date = local("2026-10-30T12:09:00.000Z");
    expect(whenLabel(date.toISOString())).toMatch(
      new RegExp(
        `^[A-Z][a-z]{2} \\d{1,2}, ${hour12(date)}:${minutes(date)} ${half(
          date
        )}$`
      )
    );
    expect(clockLabel("2026-10-30T12:09:07.000Z")).toMatch(
      /^\d{1,2}:09:07 [ap]m$/
    );
  });
  it("say a range within a day briefly and name the days when they differ", () => {
    const start = local("2026-10-30T12:22:00.000Z");
    const end = new Date(start.getTime() + 60 * 60000);
    const label = timeRangeLabel(start.toISOString(), end.toISOString());
    const sameHalf = half(start) === half(end);
    expect(label).toBe(
      `${hour12(start)}:${minutes(start)}${
        sameHalf ? "" : ` ${half(start)}`
      } – ${hour12(end)}:${minutes(end)} ${half(end)}`
    );
    const nextDay = new Date(start.getTime() + 30 * 60 * 60000);
    expect(timeRangeLabel(start.toISOString(), nextDay.toISOString())).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [ap]m – [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [ap]m$/
    );
  });
});

describe("commitPullRequestNumber", () => {
  const own = {
    number: 202963,
    url: "https://github.com/pytorch/pytorch/pull/202963",
    title: null,
  };
  it("is the commit's own pull request, else the one its title ends in, else none", () => {
    expect(
      commitPullRequestNumber({ title: "Fix it (#77)", pull_request: own })
    ).toBe(202963);
    expect(
      commitPullRequestNumber({ title: "Fix it (#77)", pull_request: null })
    ).toBe(77);
    expect(
      commitPullRequestNumber({
        title: 'Revert "Fix it (#77)"',
        pull_request: null,
      })
    ).toBeNull();
  });
});

describe("summary labels", () => {
  it("mark the problem statuses with a hue and leave the rest plain", () => {
    expect(problemHue("failed")).toBe("red");
    expect(problemHue("timed_out")).toBe("red");
    expect(problemHue("flaky")).toBe("yellow");
    expect(problemHue("passed")).toBeNull();
    expect(problemHue("skipped")).toBeNull();
    expect(problemHue("xfailed")).toBeNull();
  });
  it("say a status as the legend's word", () => {
    expect(statusWord("timed_out")).toBe("timed out");
    expect(statusWord("xfailed")).toBe("expected failures");
    expect(statusWord("passed")).toBe("passed");
  });
});

// Counts with each status's runs and jobs; the tests behind them are a
// third of the runs, as on a main commit, and the worst-status counts a
// third again.
function counts(
  byRuns: Partial<Record<string, [number, number]>>
): CommitTestCounts {
  const statuses = [
    "failed",
    "timed_out",
    "flaky",
    "passed",
    "other",
    "xfailed",
    "skipped",
  ] as const;
  const byStatus = Object.fromEntries(
    statuses.map((status) => {
      const [runs, jobs] = byRuns[status] ?? [0, 0];
      return [status, { runs, jobs, tests: Math.ceil(runs / 3) }];
    })
  ) as CommitTestCounts["by_status"];
  const byWorst = Object.fromEntries(
    statuses.map((status) => [
      status,
      { tests: Math.ceil(byStatus[status].tests / 3), jobs: 0 },
    ])
  ) as CommitTestCounts["by_worst_status"];
  const runs = statuses.reduce((sum, status) => sum + byStatus[status].runs, 0);
  return {
    total: { tests: Math.ceil(runs / 12), jobs: 333, runs },
    by_worst_status: byWorst,
    by_status: byStatus,
  };
}

describe("summaryStatuses", () => {
  it("lists the statuses with runs in order, weighted by log10(runs + 1), with their true share", () => {
    const statuses = summaryStatuses(
      counts({
        failed: [5, 5],
        timed_out: [8, 4],
        flaky: [87, 46],
        passed: [4721574, 333],
        xfailed: [81000, 290],
        skipped: [4375055, 326],
      })
    );
    expect(statuses.map((item) => item.status)).toEqual([
      "failed",
      "timed_out",
      "flaky",
      "passed",
      "xfailed",
      "skipped",
    ]);
    expect(statuses.map((item) => item.weight)).toEqual(
      [6, 9, 88, 4721575, 81001, 4375056].map((runs) => Math.log10(runs))
    );
    // The bar is not to scale: five failures get about a tenth of the
    // passes' width; the share says what the proportion is.
    expect(statuses[0].weight / statuses[3].weight).toBeCloseTo(0.117, 3);
    expect(statuses.map((item) => item.share)).toEqual([
      "under 0.01%",
      "under 0.01%",
      "under 0.01%",
      "51.4%",
      "0.883%",
      "47.7%",
    ]);
    expect(statuses[0].counts).toEqual({ runs: 5, jobs: 5, tests: 2 });
  });
  it("leaves out a status with no runs", () => {
    expect(
      summaryStatuses(
        counts({ timed_out: [8, 4], flaky: [33, 22], passed: [1, 1] })
      ).map((item) => item.status)
    ).toEqual(["timed_out", "flaky", "passed"]);
    expect(summaryStatuses(counts({}))).toEqual([]);
  });
});

describe("shareLabel", () => {
  it("gives three figures, a floor below a hundredth of a percent, and nothing of nothing", () => {
    expect(shareLabel(100, 100)).toBe("100%");
    expect(shareLabel(1, 3)).toBe("33.3%");
    expect(shareLabel(1, 10000)).toBe("0.01%");
    expect(shareLabel(1, 10001)).toBe("under 0.01%");
    expect(shareLabel(0, 0)).toBe("0%");
    expect(shareLabel(999, 1000)).toBe("99.9%");
    // 99.992% rounds to 100 at three figures, but not every run passed.
    expect(shareLabel(9177000, 9177729)).toBe("over 99.9%");
  });
});

describe("the counts' fit", () => {
  it("keeps the full size while the counts fit, steps down a pixel at a time and stops at the facts' size", () => {
    // The counts' width at a figure size: 100px of dots and words, 40px a
    // pixel of figures.
    const widthAt = (size: number) => 100 + 40 * size;
    expect(fittingCountSize(100 + 40 * COUNT_FIGURE_SIZE, widthAt)).toBe(
      COUNT_FIGURE_SIZE
    );
    const tried: number[] = [];
    expect(
      fittingCountSize(100 + 40 * 19 + 10, (size) => {
        tried.push(size);
        return widthAt(size);
      })
    ).toBe(19);
    expect(tried).toEqual([22, 21, 20, 19]);
    // Nothing fits: the floor, the facts' own size, never tried below.
    expect(fittingCountSize(0, widthAt)).toBe(COUNT_FIGURE_MIN_SIZE);
    expect(COUNT_FIGURE_MIN_SIZE).toBe(SUMMARY_TEXT_SIZE);
  });
  it("shrinks the gap between counts with the figures", () => {
    expect(countGap(COUNT_FIGURE_SIZE)).toBe(COUNT_GAP);
    expect(countGap(18)).toBe(25);
    expect(countGap(COUNT_FIGURE_MIN_SIZE)).toBe(20);
  });
});

describe("allPassed", () => {
  it("holds when the commit has runs and none failed, timed out or was flaky", () => {
    expect(
      allPassed(
        counts({
          passed: [172935, 108],
          xfailed: [3908, 90],
          skipped: [48024, 100],
        })
      )
    ).toBe(true);
    expect(allPassed(counts({ flaky: [36, 21], passed: [10, 3] }))).toBe(false);
    expect(allPassed(counts({ failed: [1, 1] }))).toBe(false);
    // A commit with no runs says nothing of passing.
    expect(allPassed(counts({}))).toBe(false);
  });
});

describe("the header's crumbs and links", () => {
  const commit = {
    sha: "ce6ff46d8ca967ef333ba9b804e081f26b432796",
    branch: "main",
    pull_request_head: false,
    pull_request: {
      number: 202376,
      url: "https://github.com/pytorch/pytorch/pull/202376",
      title: null,
    },
  };

  test("a branch commit: the list, HUD's branch view, and the short SHA with no link", () => {
    expect(commitCrumbs("pytorch/pytorch", commit)).toEqual([
      { text: "pytorch/pytorch", href: "/tests/pytorch/pytorch" },
      { text: "main", href: "/hud/pytorch/pytorch/main/1" },
      { text: "ce6ff46" },
    ]);
  });

  test("a pull request head: the pull request's number links its page, not its branch", () => {
    expect(
      commitCrumbs("pytorch/pytorch", {
        ...commit,
        branch: "gh/hameerabbasi/12/head",
        pull_request_head: true,
      })[1]
    ).toEqual({
      text: "#202376",
      href: "https://github.com/pytorch/pytorch/pull/202376",
    });
    expect(
      commitCrumbs("pytorch/pytorch", {
        ...commit,
        branch: null,
        pull_request_head: true,
        pull_request: null,
      }).map((crumb) => crumb.text)
    ).toEqual(["pytorch/pytorch", "ce6ff46"]);
    // A branch commit with no known branch has only the repository.
    expect(
      commitCrumbs("pytorch/pytorch", { ...commit, branch: null }).map(
        (crumb) => crumb.text
      )
    ).toEqual(["pytorch/pytorch", "#202376", "ce6ff46"]);
  });

  test("a pull request named in the title links the commit's own when it is the one", () => {
    expect(pullRequestUrl("pytorch/pytorch", 202376, commit)).toBe(
      "https://github.com/pytorch/pytorch/pull/202376"
    );
    expect(pullRequestUrl("pytorch/pytorch", 7, commit)).toBe(
      "https://github.com/pytorch/pytorch/pull/7"
    );
    expect(shortSha(commit.sha)).toBe("ce6ff46");
  });
});
