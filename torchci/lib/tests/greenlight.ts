import type {
  CommitGreenlight,
  GreenlightStatus,
  GreenlightVerdict,
  NoVerdictReason,
} from "lib/api/tests/commit/greenlight/types";
import { describeGreenlightStatus } from "lib/greenlight/greenlightHudState";
import {
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";
import { isReportableStatus } from "lib/greenlight/greenlightReport";

// The commit page's GreenLight signal: what the header's pill says for what
// GET /api/tests/commit/{sha}/greenlight answers, a verdict, none, or no
// answer at all, and where the tray it opens sits. Free of React, so the
// tests run it as plain functions. What a status means is not decided here:
// the headline, the body and the reason are the HUD's own
// (describeGreenlightStatus), the ones the verdict panel and the Dr.CI
// comment use.

// The pill's color, as the user set it on 2026-11-11: green for an
// approval; yellow where a human is needed, a refusal and a revert; the
// facts' grey where there is no verdict to color, a review in flight,
// whose lamp alone has color, a review that did not complete, a commit with
// none, an answer that did not come.
export type GreenlightTone = "positive" | "caution" | "neutral";

// The pill's lamp: lit for a verdict; pulsing while a review is in flight,
// between the yellow and the green it may end in; unlit where there is no
// verdict: a review that did not complete, a commit with none, an answer
// that did not come.
export type GreenlightLamp = "lit" | "pulsing" | "unlit";

// What the pill says, whatever is behind it.
export interface GreenlightWords {
  tone: GreenlightTone;
  lamp: GreenlightLamp;
  // The pill's words after "Green Light".
  word: string;
  // The sentence for it, the pill's tooltip and the tray's first line.
  headline: string;
}

type Presentation = Pick<GreenlightWords, "tone" | "lamp" | "word">;

// A review in flight: a grey pill whose lamp alone has color and moves,
// between yellow and green. The user, 2026-11-11, after the whole pill
// swinging between the two ("The pulsing between green and yellow is
// actually confusing") and then a green pill with the pulsing lamp: "No
// this is not what I meant. Reviewing pill should be grey. But the dot
// should be pulsating with yellow and green."
const REVIEWING: Presentation = {
  tone: "neutral",
  lamp: "pulsing",
  word: "Reviewing",
};

// A review in flight for over an hour: its verdict never arrived.
const STALLED: Presentation = {
  tone: "neutral",
  lamp: "unlit",
  word: "Inference stalled",
};

// How each status is presented. A refusal is yellow, not red: it is the
// usual outcome and asks for a human, where red on this page is a failed
// test; the Dr.CI comment's lamp for it is yellow too. A review that
// reached no verdict is grey, as wherever there is no verdict; red was
// tried for it and withdrawn the same day (the user, 2026-11-11: "the red
// is confusing"). It says how it ended, in the word the tray's link to its
// job uses, the inference: the reader is told that it failed, and where to
// look.
const PRESENTATIONS: Record<GreenlightStatus, Presentation> = {
  [GREENLIGHT_STATUS_LAND]: { tone: "positive", lamp: "lit", word: "Approved" },
  [GREENLIGHT_STATUS_NO_LAND]: {
    tone: "caution",
    lamp: "lit",
    word: "Needs human review",
  },
  [GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED]: REVIEWING,
  [GREENLIGHT_STATUS_AI_REVIEW_STARTED]: REVIEWING,
  [GREENLIGHT_STATUS_CANCELLED]: {
    tone: "neutral",
    lamp: "unlit",
    word: "Inference cancelled",
  },
  [GREENLIGHT_STATUS_FAILED]: {
    tone: "neutral",
    lamp: "unlit",
    word: "Inference failed",
  },
  [GREENLIGHT_STATUS_REVERTED]: {
    tone: "caution",
    lamp: "lit",
    word: "Reverted",
  },
};

// What the status's time is the time of, as the tray's foot says it,
// "Reviewed Nov 10, 8:46 am": a verdict was reached then and a review began
// then; any other status was recorded then.
const TIME_WORDS: Record<GreenlightStatus, string> = {
  [GREENLIGHT_STATUS_LAND]: "Reviewed",
  [GREENLIGHT_STATUS_NO_LAND]: "Reviewed",
  [GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED]: "Started",
  [GREENLIGHT_STATUS_AI_REVIEW_STARTED]: "Started",
  [GREENLIGHT_STATUS_CANCELLED]: "Updated",
  [GREENLIGHT_STATUS_FAILED]: "Updated",
  [GREENLIGHT_STATUS_REVERTED]: "Updated",
};

export interface GreenlightSignal extends GreenlightWords {
  // Fixed prose for a status that carries no message; empty otherwise.
  body: string;
  // The reason code to show beside the headline; empty for none.
  reason: string;
  // What the status's time is the time of: "Reviewed", "Started", "Updated".
  timeWord: string;
  // A review is in flight, so the verdict is asked for again.
  reviewing: boolean;
  // The status is a judgement, which a reader may report as wrong.
  reportable: boolean;
}

// What the pill and its tray say for a verdict at a moment: an in-flight
// status more than an hour old is a review that stalled, so the moment
// matters. Null for a status the HUD has nothing to say for.
export function greenlightSignal(
  verdict: Pick<GreenlightVerdict, "status" | "reason" | "updated_at">,
  now: Date
): GreenlightSignal | null {
  const described = describeGreenlightStatus(
    verdict.status,
    verdict.reason,
    verdict.updated_at,
    now
  );
  if (described === undefined) return null;
  // The HUD shows a stalled review under another status than the row's own.
  const presentation =
    described.iconStatus === verdict.status
      ? PRESENTATIONS[verdict.status]
      : STALLED;
  if (presentation === undefined) return null;
  return {
    ...presentation,
    headline: described.headline,
    body: described.body,
    reason: described.reason,
    timeWord: TIME_WORDS[verdict.status],
    reviewing: presentation === REVIEWING,
    reportable: isReportableStatus(verdict.status),
  };
}

// The reasons for no verdict that get a pill: the commit is one GreenLight
// could have a verdict on, a commit HUD knows in a repository GreenLight
// reviews. The other two have no pill: the page has no header for a commit
// HUD does not know, and GreenLight is nothing to a repository it does not
// review.
export type ShownNoVerdictReason = Exclude<
  NoVerdictReason,
  "unknown_commit" | "repository_not_reviewed"
>;

const NO_VERDICT: Record<
  ShownNoVerdictReason,
  { headline: string; body: string }
> = {
  not_reviewed: {
    headline: "Green Light has no review of this commit",
    body: "",
  },
  no_pull_request: {
    headline: "This commit is not part of a pull request",
    body: "Green Light reviews pull requests.",
  },
  unrecognized_status: {
    headline: "Green Light recorded a status HUD does not recognize",
    body: "",
  },
};

// What the pill and its tray say for a commit with no verdict: that it has
// none, and what is known of why.
export function noVerdictSignal(
  reason: ShownNoVerdictReason
): GreenlightWords & { body: string } {
  return {
    tone: "neutral",
    lamp: "unlit",
    word: "No verdict",
    ...NO_VERDICT[reason],
  };
}

// What the pill says when the verdict could not be read; the tray under it
// says why and asks again.
export const UNAVAILABLE_WORDS: GreenlightWords = {
  tone: "neutral",
  lamp: "unlit",
  word: "Unavailable",
  headline: "Green Light's verdict could not be loaded",
};

// What the header has to show for a commit's GreenLight verdict: the
// verdict, that there is none and why, that it could not be read, with the
// way to ask again, or that the answer is on its way, so the pill's place
// is held.
export type CommitGreenlightState =
  | { kind: "loading" }
  | { kind: "verdict"; verdict: GreenlightVerdict }
  | { kind: "no_verdict"; reason: ShownNoVerdictReason }
  | { kind: "unavailable"; error: unknown; retry: () => void };

// The state for what the endpoint answered, or failed with. An answer once
// read is kept over a later failure: a refresh that fails leaves the verdict
// shown. Null where the commit gets no pill (ShownNoVerdictReason).
export function commitGreenlightState(
  answer: CommitGreenlight | undefined,
  error: unknown,
  retry: () => void
): CommitGreenlightState | null {
  if (answer === undefined) {
    return error === undefined
      ? { kind: "loading" }
      : { kind: "unavailable", error, retry };
  }
  if (answer.verdict !== null) {
    return { kind: "verdict", verdict: answer.verdict };
  }
  switch (answer.no_verdict_reason) {
    case "not_reviewed":
    case "no_pull_request":
    case "unrecognized_status":
      return { kind: "no_verdict", reason: answer.no_verdict_reason };
    default:
      return null;
  }
}

// How often a review in flight is asked about again, in milliseconds: a
// review takes tens of minutes, and its verdict replaces the pill's
// "Reviewing" when it lands.
export const REVIEWING_REFRESH_MS = 60 * 1000;

// How long until the verdict is asked for again, as SWR takes it: a minute
// while a review is in flight at that moment, and 0, never, for anything
// else: a verdict, no verdict, a review that stalled.
export function greenlightRefreshMs(
  verdict: GreenlightVerdict | null | undefined,
  now: Date
): number {
  return verdict != null && greenlightSignal(verdict, now)?.reviewing
    ? REVIEWING_REFRESH_MS
    : 0;
}

// The tray's widest, in px.
export const TRAY_WIDTH = 560;

export interface TrayPlacement {
  // The left edge of the tray's place, from the pill's.
  left: number;
  // The place's width, the widest the tray may be there.
  width: number;
}

// The place the tray has under its pill, within the bounds it may not
// cross, the row of pills: its left edge on the pill's while it fits, else
// its right edge on the pill's, and in bounds too narrow for either, against
// the nearer bound; never wider than the bounds. A tray narrower than its
// place sits against the edge the place hangs from: the left where the
// place starts at the pill's left edge, else the right.
export function trayPlacement(
  pill: { left: number; right: number },
  bounds: { left: number; right: number }
): TrayPlacement {
  const width = Math.max(0, Math.min(TRAY_WIDTH, bounds.right - bounds.left));
  let left = pill.left;
  if (left + width > bounds.right) left = pill.right - width;
  left = Math.max(bounds.left, Math.min(left, bounds.right - width));
  return { left: left - pill.left, width };
}
