// The commit page's GreenLight signal: what the pill says for each status,
// for a commit with no verdict and for a verdict that could not be read,
// when it is asked for again, where its tray sits, and the pill as it is
// drawn before it is pressed, in the header's first place. The tray it
// opens is greenlightTray.test.tsx's.

import { createTheme, ThemeProvider } from "@mui/material";
import CommitHeader from "components/tests/CommitHeader";
import FactPill from "components/tests/FactPill";
import GreenLightPill from "components/tests/GreenLightPill";
import type {
  CommitGreenlight,
  GreenlightStatus,
  GreenlightVerdict,
} from "lib/api/tests/commit/greenlight/types";
import { GREENLIGHT_STATUSES } from "lib/api/tests/commit/greenlight/types";
import type { CommitRecord } from "lib/api/tests/commit/summary/types";
import {
  GREENLIGHT_INCOMPLETE_HEADLINE,
  GREENLIGHT_LAND_HEADLINE,
  GREENLIGHT_NO_LAND_HEADLINE,
  GREENLIGHT_REVERTED_BODY,
  GREENLIGHT_REVERTED_HEADLINE,
  GREENLIGHT_REVIEWING_BODY,
  GREENLIGHT_REVIEWING_HEADLINE,
} from "lib/greenlight/greenlightRender";
import { GREENLIGHT_IN_PROGRESS_STALE_MS } from "lib/greenlight/greenlightStaleness";
import { hueColors } from "lib/tests/blockColors";
import { commitGreenlightApiUrl } from "lib/tests/commitPage";
import {
  CommitGreenlightState,
  commitGreenlightState,
  greenlightRefreshMs,
  greenlightSignal,
  noVerdictSignal,
  REVIEWING_REFRESH_MS,
  TRAY_WIDTH,
  trayPlacement,
  UNAVAILABLE_WORDS,
} from "lib/tests/greenlight";
import {
  headerBandColor,
  headerBandHoverColor,
  lampColor,
  tonePillColors,
} from "lib/tests/headerColors";
import { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = "pytorch/pytorch";
const SHA = "573c889f49603f0bd8d0033ef6a49e3016d863d3";
const JOB = "https://github.com/pytorch/test-infra/actions/runs/42857520608";
const RECORDED_AT = "2026-11-10T16:46:47.169Z";
const NOW = new Date("2026-11-10T17:00:00.000Z");
const OUTLINE =
  "- Triviality\n  - Four separate perf rewrites in the hot path (`step`, `popn`)\n- Tests\n  - Diff adds no tests";

function verdictOf(overrides: Partial<GreenlightVerdict> = {}) {
  const verdict: GreenlightVerdict = {
    status: "NO_LAND",
    reason: "not_trivial",
    message: OUTLINE,
    pull_request_number: 204150,
    head_sha: SHA,
    updated_at: RECORDED_AT,
    job_url: JOB,
    ...overrides,
  };
  return verdict;
}

// What the header is given for a verdict.
function verdictState(overrides: Partial<GreenlightVerdict> = {}) {
  const state: CommitGreenlightState = {
    kind: "verdict",
    verdict: verdictOf(overrides),
  };
  return state;
}

describe("greenlightSignal", () => {
  test("an approval is green, lit and reportable, and its clean reason is left out", () => {
    expect(
      greenlightSignal(verdictOf({ status: "LAND", reason: "clean" }), NOW)
    ).toEqual({
      tone: "positive",
      lamp: "lit",
      word: "Approved",
      headline: GREENLIGHT_LAND_HEADLINE,
      body: "",
      reason: "",
      timeWord: "Reviewed",
      reviewing: false,
      reportable: true,
    });
  });

  test("a refusal is yellow, never red, and carries its reason", () => {
    expect(greenlightSignal(verdictOf(), NOW)).toEqual({
      tone: "caution",
      lamp: "lit",
      word: "Needs human review",
      headline: GREENLIGHT_NO_LAND_HEADLINE,
      body: "",
      reason: "not_trivial",
      timeWord: "Reviewed",
      reviewing: false,
      reportable: true,
    });
  });

  test.each<[GreenlightStatus]>([
    ["AI_REVIEW_DISPATCHED"],
    ["AI_REVIEW_STARTED"],
  ])("a review in flight (%s) is grey, its lamp pulsing", (status) => {
    expect(
      greenlightSignal(verdictOf({ status, reason: "", message: "" }), NOW)
    ).toEqual({
      tone: "neutral",
      lamp: "pulsing",
      word: "Reviewing",
      headline: GREENLIGHT_REVIEWING_HEADLINE,
      body: GREENLIGHT_REVIEWING_BODY,
      reason: "",
      timeWord: "Started",
      reviewing: true,
      reportable: false,
    });
  });

  test("a review in flight for an hour has stalled, to the millisecond", () => {
    const started = Date.parse(RECORDED_AT);
    const inFlight = verdictOf({ status: "AI_REVIEW_STARTED", reason: "" });
    expect(
      greenlightSignal(
        inFlight,
        new Date(started + GREENLIGHT_IN_PROGRESS_STALE_MS - 1)
      )
    ).toMatchObject({ word: "Reviewing", reviewing: true });
    expect(
      greenlightSignal(
        inFlight,
        new Date(started + GREENLIGHT_IN_PROGRESS_STALE_MS)
      )
    ).toEqual({
      tone: "neutral",
      lamp: "unlit",
      word: "Inference stalled",
      headline: GREENLIGHT_INCOMPLETE_HEADLINE,
      body: "",
      reason: "stalled",
      // The row's own time is still when the review began.
      timeWord: "Started",
      reviewing: false,
      reportable: false,
    });
  });

  test.each<[GreenlightStatus, string, string]>([
    ["CANCELLED", "cancelled", "Inference cancelled"],
    ["FAILED", "failed", "Inference failed"],
  ])(
    "a review that ended %s is grey and unlit, and says how it ended",
    (status, reason, word) => {
      expect(greenlightSignal(verdictOf({ status, reason: "" }), NOW)).toEqual({
        tone: "neutral",
        lamp: "unlit",
        word,
        headline: GREENLIGHT_INCOMPLETE_HEADLINE,
        body: "",
        reason,
        timeWord: "Updated",
        reviewing: false,
        reportable: false,
      });
    }
  );

  test("a reverted pull request is yellow and not a judgement to report", () => {
    expect(
      greenlightSignal(verdictOf({ status: "REVERTED", reason: "" }), NOW)
    ).toEqual({
      tone: "caution",
      lamp: "lit",
      word: "Reverted",
      headline: GREENLIGHT_REVERTED_HEADLINE,
      body: GREENLIGHT_REVERTED_BODY,
      reason: "",
      timeWord: "Updated",
      reviewing: false,
      reportable: false,
    });
  });

  test("every status the API answers has a signal, in a word or three", () => {
    for (const status of GREENLIGHT_STATUSES) {
      const signal = greenlightSignal(verdictOf({ status }), NOW);
      expect(signal).not.toBeNull();
      expect(signal!.word.split(" ").length).toBeLessThanOrEqual(3);
    }
  });

  test("a status the HUD has no words for has no signal", () => {
    expect(
      greenlightSignal(
        verdictOf({ status: "PENDING" as GreenlightStatus }),
        NOW
      )
    ).toBeNull();
  });
});

describe("noVerdictSignal", () => {
  test("a commit of a pull request GreenLight has no review of says so", () => {
    expect(noVerdictSignal("not_reviewed")).toEqual({
      tone: "neutral",
      lamp: "unlit",
      word: "No verdict",
      headline: "Green Light has no review of this commit",
      body: "",
    });
  });

  test("a commit of no pull request says that, and what GreenLight reviews", () => {
    expect(noVerdictSignal("no_pull_request")).toEqual({
      tone: "neutral",
      lamp: "unlit",
      word: "No verdict",
      headline: "This commit is not part of a pull request",
      body: "Green Light reviews pull requests.",
    });
  });

  test("a status HUD does not know is not passed off as no review", () => {
    expect(noVerdictSignal("unrecognized_status")).toEqual({
      tone: "neutral",
      lamp: "unlit",
      word: "No verdict",
      headline: "Green Light recorded a status HUD does not recognize",
      body: "",
    });
  });

  test("a verdict that could not be read is grey and unlit too, in its own words", () => {
    expect(UNAVAILABLE_WORDS).toEqual({
      tone: "neutral",
      lamp: "unlit",
      word: "Unavailable",
      headline: "Green Light's verdict could not be loaded",
    });
  });
});

describe("commitGreenlightState", () => {
  const retry = () => undefined;
  const answered = (
    overrides: Partial<CommitGreenlight>
  ): CommitGreenlight => ({
    verdict: null,
    no_verdict_reason: null,
    hud_url: `https://hud.pytorch.org/tests/${REPO}/commit/${SHA}`,
    query_duration_ms: 700,
    ...overrides,
  });

  test("until the endpoint answers, the answer is on its way", () => {
    expect(commitGreenlightState(undefined, undefined, retry)).toEqual({
      kind: "loading",
    });
  });

  test("an answer with a verdict is the verdict", () => {
    expect(
      commitGreenlightState(
        answered({ verdict: verdictOf() }),
        undefined,
        retry
      )
    ).toEqual({ kind: "verdict", verdict: verdictOf() });
  });

  test.each([
    ["not_reviewed"],
    ["no_pull_request"],
    ["unrecognized_status"],
  ] as const)("no verdict because %s is said, with its reason", (reason) => {
    expect(
      commitGreenlightState(
        answered({ no_verdict_reason: reason }),
        undefined,
        retry
      )
    ).toEqual({ kind: "no_verdict", reason });
  });

  test.each([["unknown_commit"], ["repository_not_reviewed"], [null]] as const)(
    "no verdict because %s has no pill",
    (reason) => {
      expect(
        commitGreenlightState(
          answered({ no_verdict_reason: reason }),
          undefined,
          retry
        )
      ).toBeNull();
    }
  );

  test("a failure with no answer is said, with the way to ask again", () => {
    const failure = new Error("An error occurred while fetching the data");
    expect(commitGreenlightState(undefined, failure, retry)).toEqual({
      kind: "unavailable",
      error: failure,
      retry,
    });
  });

  test("a refresh that fails leaves the answer it had", () => {
    expect(
      commitGreenlightState(
        answered({ verdict: verdictOf({ status: "AI_REVIEW_STARTED" }) }),
        new Error("An error occurred while fetching the data"),
        retry
      )
    ).toMatchObject({ kind: "verdict" });
  });
});

describe("greenlightRefreshMs", () => {
  test("asks again each minute only while a review is in flight", () => {
    const reviewing = verdictOf({ status: "AI_REVIEW_STARTED", reason: "" });
    expect(greenlightRefreshMs(reviewing, NOW)).toBe(REVIEWING_REFRESH_MS);
    expect(REVIEWING_REFRESH_MS).toBe(60_000);
    // A stalled review will not finish, so nothing is asked again.
    expect(
      greenlightRefreshMs(
        reviewing,
        new Date(Date.parse(RECORDED_AT) + GREENLIGHT_IN_PROGRESS_STALE_MS)
      )
    ).toBe(0);
    for (const status of ["LAND", "NO_LAND", "FAILED", "REVERTED"] as const) {
      expect(greenlightRefreshMs(verdictOf({ status }), NOW)).toBe(0);
    }
    expect(greenlightRefreshMs(null, NOW)).toBe(0);
    expect(greenlightRefreshMs(undefined, NOW)).toBe(0);
  });
});

describe("commitGreenlightApiUrl", () => {
  test("asks the API for the commit in the repository", () => {
    expect(commitGreenlightApiUrl(REPO, SHA)).toBe(
      `/api/tests/commit/${SHA}/greenlight?repo=pytorch%2Fpytorch`
    );
  });
});

describe("trayPlacement", () => {
  const row = { left: 16, right: 1408 };

  test("sits under the pill's left edge while it fits the row", () => {
    expect(trayPlacement({ left: 200, right: 460 }, row)).toEqual({
      left: 0,
      width: TRAY_WIDTH,
    });
    // Flush with the row's right edge still fits.
    expect(
      trayPlacement({ left: 1408 - TRAY_WIDTH, right: 1200 }, row)
    ).toEqual({ left: 0, width: TRAY_WIDTH });
  });

  test("else sits under the pill's right edge", () => {
    // The pill at the row's end, where the commit page has it.
    expect(trayPlacement({ left: 930, right: 1205 }, row)).toEqual({
      left: 1205 - TRAY_WIDTH - 930,
      width: TRAY_WIDTH,
    });
  });

  test("in a row with room for neither, keeps to the row", () => {
    // A 700px window: under the pill's right edge it would cross the row's
    // left.
    expect(
      trayPlacement({ left: 291, right: 566 }, { left: 23, right: 662 })
    ).toEqual({ left: 23 - 291, width: TRAY_WIDTH });
  });

  test("is never wider than the row", () => {
    expect(
      trayPlacement({ left: 23, right: 298 }, { left: 23, right: 382 })
    ).toEqual({ left: 0, width: 359 });
    expect(
      trayPlacement({ left: 10, right: 20 }, { left: 30, right: 20 })
    ).toEqual({ left: 20, width: 0 });
  });
});

describe("the pill's colors", () => {
  test("a status's tone is the hub's hue, pale with its ink, in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = createTheme({ palette: { mode } });
      expect(tonePillColors(theme, "positive")).toEqual(
        hueColors(theme, "green")
      );
      expect(tonePillColors(theme, "caution")).toEqual(
        hueColors(theme, "yellow")
      );
      // A lamp for each tone, and the secondary text for a pill with none.
      expect(lampColor(theme, "positive")).not.toBe(
        lampColor(theme, "caution")
      );
      expect(lampColor(theme, undefined)).toBe(theme.palette.text.secondary);
    }
  });
});

const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

function rendered(element: ReactElement, mode: "light" | "dark" = "light") {
  const markup = renderToStaticMarkup(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      {element}
    </ThemeProvider>
  );
  return {
    // The markup without the styles Emotion writes beside it, and those.
    html: markup.replace(STYLE, ""),
    css: Array.from(markup.matchAll(STYLE), (match) => match[1]).join("\n"),
  };
}

function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("FactPill", () => {
  const press = () => undefined;

  test("is a span to read, a link where it leads, a button where it opens", () => {
    const read = rendered(<FactPill label="Branch">main</FactPill>).html;
    expect(read).toMatch(/^<span\b/);
    expect(words(read)).toBe("Branch main");
    expect(read).not.toContain("<svg");

    const pull = "https://github.com/pytorch/pytorch/pull/204150";
    const link = rendered(
      <FactPill label="PR" href={pull}>
        #204150
      </FactPill>
    ).html;
    expect(link).toMatch(/^<a\b/);
    expect(link).toContain(`href="${pull}"`);

    const button = rendered(
      <FactPill label="Green Light" onClick={press}>
        Approved
      </FactPill>
    ).html;
    expect(button).toMatch(/^<button\b/);
    expect(button).toContain('type="button"');
    expect(words(button)).toBe("Green Light Approved");
    // It ends in a chevron, which is not there to be read.
    expect(button).toMatch(/<svg\b[^>]*aria-hidden="true"/);
  });

  test("as a button, names what it opens only while that is open", () => {
    const closed = rendered(
      <FactPill onClick={press} controls="tray">
        Approved
      </FactPill>
    );
    expect(closed.html).toContain('aria-expanded="false"');
    expect(closed.html).not.toContain("aria-controls");
    expect(closed.css).not.toContain("rotate(180deg)");
    const open = rendered(
      <FactPill onClick={press} expanded controls="tray">
        Approved
      </FactPill>
    );
    expect(open.html).toContain('aria-expanded="true"');
    expect(open.html).toContain('aria-controls="tray"');
    // The chevron turns over.
    expect(open.css).toContain("rotate(180deg)");
  });

  test("as a button, keeps the look it has under the pointer while that is open", () => {
    const theme = createTheme();
    const times = (css: string, declaration: string) =>
      css.split(declaration).length - 1;
    // In the facts' grey: the band's darker step, under the pointer alone
    // while closed, and its own once open.
    const darker = `background-color:${headerBandHoverColor(theme)}`;
    const grey = (expanded: boolean) =>
      rendered(
        <FactPill onClick={press} expanded={expanded} controls="tray">
          Reviewing
        </FactPill>
      ).css;
    expect(times(grey(false), darker)).toBe(1);
    expect(times(grey(true), darker)).toBe(2);
    // In a status's tone: the ring of its ink.
    const ring = "box-shadow:inset 0 0 0 1px currentColor";
    const toned = (expanded: boolean) =>
      rendered(
        <FactPill
          tone="positive"
          onClick={press}
          expanded={expanded}
          controls="tray"
        >
          Approved
        </FactPill>
      ).css;
    expect(times(toned(false), ring)).toBe(1);
    expect(times(toned(true), ring)).toBe(2);
  });

  test("in a status's tone is the hue's, the value told from the label by weight", () => {
    for (const mode of ["light", "dark"] as const) {
      const green = hueColors(createTheme({ palette: { mode } }), "green");
      const toned = rendered(
        <FactPill tone="positive" label="Green Light" onClick={press}>
          Approved
        </FactPill>,
        mode
      ).css;
      expect(toned).toContain(`background-color:${green.background}`);
      expect(toned).toContain(`color:${green.text}`);
      expect(toned).toContain("font-weight:600");
      // Under the pointer it is ringed in its ink, as a Health block is.
      expect(toned).toContain("box-shadow:inset 0 0 0 1px currentColor");
    }
    const grey = rendered(<FactPill label="Branch">main</FactPill>).css;
    expect(grey).toContain("font-weight:500");
    expect(grey).not.toContain("font-weight:600");
    expect(grey).not.toContain("box-shadow");
  });
});

describe("FactPill, still", () => {
  test("a pill in a tone, or in none, does not move", () => {
    const press = () => undefined;
    const toned = rendered(
      <FactPill tone="positive" onClick={press}>
        Approved
      </FactPill>
    ).css;
    const grey = rendered(<FactPill onClick={press}>No verdict</FactPill>).css;
    for (const css of [toned, grey]) {
      expect(css).not.toContain("animation");
      expect(css).not.toContain("prefers-reduced-motion");
    }
  });
});

describe("the pill, closed", () => {
  test("is a button naming GreenLight and the verdict, with nothing open", () => {
    const { html } = rendered(
      <GreenLightPill repo={REPO} sha={SHA} state={verdictState()} />
    );
    expect(words(html)).toBe("Green Light Needs human review");
    const button = /<button\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).not.toContain("aria-controls");
    // The sentence the HUD says for the status is its tooltip.
    expect(button).toContain(`title="${GREENLIGHT_NO_LAND_HEADLINE}"`);
    expect(html).not.toContain('role="region"');
    // The model's words are not on the page until the tray is opened.
    expect(html).not.toContain("Triviality");
  });

  test.each([
    ["LAND", "positive", "green"],
    ["NO_LAND", "caution", "yellow"],
    ["REVERTED", "caution", "yellow"],
  ] as const)(
    "%s is painted in the %s tone, the hub's %s, in both modes, and is still",
    (status, tone, hue) => {
      for (const mode of ["light", "dark"] as const) {
        const theme = createTheme({ palette: { mode } });
        const { css } = rendered(
          <GreenLightPill
            repo={REPO}
            sha={SHA}
            state={verdictState({ status })}
          />,
          mode
        );
        expect(css).toContain(
          `background-color:${hueColors(theme, hue).background}`
        );
        expect(css).toContain(`color:${hueColors(theme, hue).text}`);
        // Its lamp is lit in the tone's light.
        expect(css).toContain(`background-color:${lampColor(theme, tone)};`);
        // Nothing of it moves without end: a verdict has been reached.
        expect(css).not.toContain("infinite");
      }
    }
  );

  // A review in flight, as the user set it: "Reviewing pill should be grey.
  // But the dot should be pulsating with yellow and green."
  test("a review in flight is in the facts' grey, and only its lamp has color, pulsing between yellow and green", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = createTheme({ palette: { mode } });
      const yellowLamp = lampColor(theme, "caution");
      const greenLamp = lampColor(theme, "positive");
      const { html, css } = rendered(
        <GreenLightPill
          repo={REPO}
          sha={SHA}
          state={verdictState({
            status: "AI_REVIEW_STARTED",
            updated_at: new Date().toISOString(),
          })}
        />,
        mode
      );
      expect(words(html)).toBe("Green Light Reviewing");
      const button = /<button\b[^>]*>/.exec(html)?.[0] ?? "";
      expect(button).toContain(`title="${GREENLIGHT_REVIEWING_HEADLINE}"`);
      // The pill is grey, as a fact's is, in no status's hue, its value in
      // the primary ink; nothing of the pill's own moves.
      expect(css).toContain(
        `background-color:${headerBandColor(theme)};color:${
          theme.palette.text.secondary
        };`
      );
      expect(css).toContain(
        `{color:${theme.palette.text.primary};font-weight:500;}`
      );
      for (const hue of ["green", "yellow", "red"] as const) {
        expect(css).not.toContain(hueColors(theme, hue).background);
      }
      expect(css).not.toContain(
        `{from{background-color:${headerBandColor(theme)}`
      );
      // Its lamp goes from the yellow to the green and back, a second each
      // way, and is the one thing that does.
      expect(css).toContain(
        `{from{background-color:${yellowLamp};}to{background-color:${greenLamp};}}`
      );
      const pulses = Array.from(
        css.matchAll(/[^-]animation:animation-\w+ ([^;]*alternate);/g),
        (match) => match[1]
      );
      expect(pulses).toEqual(["1000ms ease-in-out infinite alternate"]);
      // A ring leaves the lamp at each turn, in the lamp's color then.
      expect(css).toMatch(
        /::after\{[^}]*background-color:inherit;[^}]*[^-]animation:animation-\w+ 1000ms ease-out infinite;\}/
      );
      // Still, the lamp is a yellow dot.
      expect(css).toContain(
        `border-radius:50%;background-color:${yellowLamp};`
      );
      const still = Array.from(
        css.matchAll(
          /@media \(prefers-reduced-motion: reduce\)\{[^{}]*\{([^{}]*)\}\}/g
        ),
        (match) => match[1]
      );
      expect(still).toEqual([
        // The pill as it arrives, the lamp's pulse, the lamp's ring.
        "-webkit-animation:none;animation:none;",
        "-webkit-animation:none;animation:none;",
        "-webkit-animation:none;animation:none;opacity:0;",
      ]);
    }
  });

  // What the pill says where there is no verdict to color, each in the
  // facts' grey and never in a status's hue: red on this page is a failed
  // test, and none of these is one (red was tried for a review that did not
  // complete and withdrawn: "the red is confusing").
  const GREY: [string, CommitGreenlightState, string, string][] = [
    [
      "an inference that failed",
      verdictState({ status: "FAILED" }),
      "Green Light Inference failed",
      GREENLIGHT_INCOMPLETE_HEADLINE,
    ],
    [
      "an inference that was cancelled",
      verdictState({ status: "CANCELLED" }),
      "Green Light Inference cancelled",
      GREENLIGHT_INCOMPLETE_HEADLINE,
    ],
    [
      "a review in flight since yesterday",
      verdictState({ status: "AI_REVIEW_STARTED" }),
      "Green Light Inference stalled",
      GREENLIGHT_INCOMPLETE_HEADLINE,
    ],
    [
      "a commit GreenLight has no review of",
      { kind: "no_verdict", reason: "not_reviewed" },
      "Green Light No verdict",
      "Green Light has no review of this commit",
    ],
    [
      "a commit of no pull request",
      { kind: "no_verdict", reason: "no_pull_request" },
      "Green Light No verdict",
      "This commit is not part of a pull request",
    ],
    [
      "a verdict that could not be read",
      { kind: "unavailable", error: new Error("no"), retry: () => undefined },
      "Green Light Unavailable",
      "Green Light&#x27;s verdict could not be loaded",
    ],
  ];
  test.each(GREY)(
    "%s has the pill too, in the facts' grey, and says so",
    (_name, state, said, tooltip) => {
      for (const mode of ["light", "dark"] as const) {
        const theme = createTheme({ palette: { mode } });
        const { html, css } = rendered(
          <GreenLightPill repo={REPO} sha={SHA} state={state} />,
          mode
        );
        expect(words(html)).toBe(said);
        expect(css).toContain(`background-color:${headerBandColor(theme)}`);
        for (const hue of ["green", "yellow", "red"] as const) {
          expect(css).not.toContain(hueColors(theme, hue).background);
        }
        // Its lamp is unlit, a hollow ring in the facts' grey, and nothing
        // of it moves without end.
        expect(css).toContain(
          `box-shadow:inset 0 0 0 1.5px ${lampColor(theme, undefined)};`
        );
        expect(css).not.toContain("infinite");
        // A button like any other state's, the sentence for it its tooltip.
        const button = /<button\b[^>]*>/.exec(html)?.[0] ?? "";
        expect(button).toContain('aria-expanded="false"');
        expect(button).toContain(`title="${tooltip}"`);
      }
    }
  );

  test("while the answer is on its way a placeholder holds the pill's place", () => {
    const { html } = rendered(
      <GreenLightPill repo={REPO} sha={SHA} state={{ kind: "loading" }} />
    );
    expect(html).toMatch(/^<span class="MuiSkeleton-root[^>]*><\/span>$/);
    expect(words(html)).toBe("");
  });

  test("a status with no signal renders nothing", () => {
    const { html } = rendered(
      <GreenLightPill
        repo={REPO}
        sha={SHA}
        state={verdictState({ status: "PENDING" as GreenlightStatus })}
      />
    );
    expect(html).toBe("");
  });
});

describe("the commit header", () => {
  const commit: CommitRecord = {
    sha: SHA,
    url: `https://github.com/pytorch/pytorch/commit/${SHA}`,
    title: "[dynamo] Trim per-instruction work in step() and popn()",
    author: { name: "Guilherme Leobas", login: "guilhermeleobas" },
    committed_at: "2026-11-10T01:49:00.000Z",
    branch: "gh/guilhermeleobas/620/head",
    pull_request_head: true,
    pull_request: {
      number: 204150,
      url: "https://github.com/pytorch/pytorch/pull/204150",
      title: "[dynamo] Trim per-instruction work in step() and popn()",
    },
    newer_sha: null,
    older_sha: null,
  };

  // The header's facts, after its breadcrumb and its headline.
  const facts = (greenlight?: CommitGreenlightState | null) => {
    const { html } = rendered(
      <CommitHeader repo={REPO} commit={commit} greenlight={greenlight} />
    );
    return { html, said: words(html.slice(html.indexOf("</h1>"))) };
  };
  const AFTER =
    "PR #204150 573c889 Author Guilherme Leobas Committed Branch gh/guilhermeleobas/620/head";

  test("begins its facts with the verdict's pill", () => {
    expect(facts(verdictState()).said).toBe(
      `Green Light Needs human review ${AFTER}`
    );
  });

  test("begins them with the pill for a commit with no verdict too", () => {
    expect(facts({ kind: "no_verdict", reason: "not_reviewed" }).said).toBe(
      `Green Light No verdict ${AFTER}`
    );
  });

  test("holds the pill's place while its answer is on its way", () => {
    const { html, said } = facts({ kind: "loading" });
    expect(said).toBe(AFTER);
    // The placeholder comes before the pull request's pill.
    const placeholder = html.indexOf("MuiSkeleton-root");
    expect(placeholder).toBeGreaterThan(-1);
    expect(placeholder).toBeLessThan(html.indexOf("#204150", placeholder));
    expect(html.lastIndexOf("#204150")).toBeGreaterThan(placeholder);
  });

  test.each([[null], [undefined]])(
    "has no pill, and holds no place for one, where the commit gets none (%s)",
    (greenlight) => {
      const { html, said } = facts(greenlight);
      expect(said).toBe(AFTER);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("MuiSkeleton-root");
    }
  );
});
