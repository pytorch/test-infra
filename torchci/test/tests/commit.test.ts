import {
  allPassed,
  barWeight,
  clockLabel,
  commitCrumbs,
  commitPullRequestNumber,
  headline,
  problemHue,
  pullRequestUrl,
  shareLabel,
  shortSha,
  statusWord,
  timeRangeLabel,
  whenLabel,
} from "lib/tests/commit";
import { noCounts } from "lib/tests/timeline";

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
  it("say a status as the counts' word", () => {
    expect(statusWord("timed_out")).toBe("timed out");
    expect(statusWord("xfailed")).toBe("expected failures");
    expect(statusWord("passed")).toBe("passed");
  });
});

describe("barWeight", () => {
  it("is the logarithm of a status's tests, and nothing for none", () => {
    expect(barWeight(0)).toBe(0);
    expect(barWeight(5)).toBe(Math.log10(6));
    // The bar is not to scale: five failures get about a tenth of the
    // passes' width; the share says what the proportion is.
    expect(barWeight(5) / barWeight(4721574)).toBeCloseTo(0.117, 3);
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

describe("allPassed", () => {
  it("holds when tests were recorded and none failed, timed out or was flaky", () => {
    expect(
      allPassed({
        ...noCounts(),
        passed: 172935,
        xfailed: 3908,
        skipped: 48024,
      })
    ).toBe(true);
    expect(allPassed({ ...noCounts(), flaky: 36, passed: 10 })).toBe(false);
    expect(allPassed({ ...noCounts(), failed: 1 })).toBe(false);
    // No test says nothing of passing.
    expect(allPassed(noCounts())).toBe(false);
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
