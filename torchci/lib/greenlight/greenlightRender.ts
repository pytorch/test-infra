// Pure rendering of the Green Light section of the Dr.CI comment, adapted from
// greenlight/src/greenlight/comment_format.py. It shares that module's status
// vocabulary and its defanging rules, so a misc.greenlight_pr_state row carries
// the same meaning whichever surface renders it -- but the two are deliberately
// not identical and are not meant to be kept so. Folding a row into the one Dr.CI
// comment is a different job from posting a standalone one: both sides collapse
// the verdict behind a <details>, but this one puts the headline in the summary
// alongside the section header, where Dr.CI's other sections keep theirs, rather
// than on a bold line of its own above the block. It also names the commit the
// verdict was reached on, renders AI_REVIEW_DISPATCHED (scan-only, so the CLI
// never sees it), and has a stalled state for a terminal row that never arrived.
// No ClickHouse / Octokit / server-only imports, so this is unit-testable as-is.

import {
  isOutdatedVerdict,
  reviewedCommitLines,
} from "lib/greenlight/greenlightCommitLine";
import { inlineCode } from "lib/greenlight/greenlightInlineCode";
import {
  capCodePoints,
  isOutline,
  renderOutlineHtml,
} from "lib/greenlight/greenlightOutline";
import { isInProgressStale } from "lib/greenlight/greenlightStaleness";
import {
  defuseSweepSentinels,
  GREENLIGHT_PENDING_ALT_ATTR,
  ZERO_WIDTH_SPACE,
} from "lib/greenlight/greenlightSweep";

export const GREENLIGHT_STATUS_LAND = "LAND";
export const GREENLIGHT_STATUS_NO_LAND = "NO_LAND";
export const GREENLIGHT_STATUS_AI_REVIEW_STARTED = "AI_REVIEW_STARTED";
export const GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED = "AI_REVIEW_DISPATCHED";
export const GREENLIGHT_STATUS_CANCELLED = "CANCELLED";
export const GREENLIGHT_STATUS_FAILED = "FAILED";
export const GREENLIGHT_STATUS_REVERTED = "REVERTED";

export const GREENLIGHT_LAND_HEADLINE =
  "PR approved to be merged without human review";
export const GREENLIGHT_NO_LAND_HEADLINE = "PR requires human review";
export const GREENLIGHT_REVIEWING_HEADLINE = "Green Light review in progress";
export const GREENLIGHT_INCOMPLETE_HEADLINE =
  "Green Light review did not complete";
export const GREENLIGHT_REVERTED_HEADLINE =
  "PR was reverted - re-landing requires human review";
export const GREENLIGHT_REVIEWING_BODY = "Green Light is reviewing this PR.";
// Says only what the row itself establishes. The row is recorded for every reverted
// candidate, including one Green Light never approved and one whose revocation
// failed, so a body claiming the approval was dismissed would be wrong on both.
export const GREENLIGHT_REVERTED_BODY =
  "Green Light will not review this PR again, on this or any later commit; re-landing it needs a human approval.";

// Leads the summary line whenever the verdict was reached on a commit that is no
// longer the PR's head. The scan writes no new row once a human has decided,
// once the PR ages out of the review window, or once it is labelled Stale, so
// the last verdict is re-rendered unchanged on every later sweep. Every other
// section of the Dr.CI comment is head-scoped and rewritten each sweep, so an
// unmarked one would read as a current statement about the new head.
export const GREENLIGHT_OUTDATED_HEADLINE_PREFIX =
  "OUTDATED (earlier commit) - ";

// The reason shown when an AI_REVIEW_STARTED row outlives the in-progress
// window: no terminal row ever arrived, so the run is presumed lost.
export const GREENLIGHT_STALLED_REASON = "stalled";

export const GREENLIGHT_SECTION_HEADER = "GREEN LIGHT";

// Mirrors _MESSAGE_CAP in comment_format.py.
export const GREENLIGHT_MESSAGE_CAP = 4000;

// GitHub does not soft-wrap inside a code fence, so an unwrapped verdict renders
// as one line behind a horizontal scrollbar. 80 is the conventional terminal and
// diff column: wide enough that wrapping a prose paragraph costs few lines,
// narrow enough to clear the PR conversation column on a narrow viewport.
// Readability only, and best-effort: a single word longer than this, or one
// padded out with zero-width spaces, goes out unwrapped. Nothing may rely on a
// rendered line being within the column.
export const GREENLIGHT_MESSAGE_WRAP_WIDTH = 80;

// Greenlight has no badge image to hang the attribute on, so the sentinel rides
// an HTML comment: invisible once GitHub renders the body, but present in the
// raw comment text the candidate query greps (the same trick as
// `<!-- drci-comment-start -->`).
const GREENLIGHT_PENDING_MARKER = `<!-- greenlight ${GREENLIGHT_PENDING_ALT_ATTR} -->`;

// Rendered only when the URL cannot break out of the `[text](url)` link AND
// points at github.com. The host anchor has to be literal `github.com/`: a
// userinfo prefix (`https://u:p@github.com/`) and a lookalike host
// (`https://github.com.example/`) both satisfy a mere "contains github.com".
const SAFE_JOB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

export interface GreenlightState {
  prNumber: number;
  status: string;
  reason: string;
  message: string;
  headSha: string;
  evalJob: string;
  version: string;
}

// Zero-width spaces are invisible, so counting them would wrap a line short by
// however many @-mentions and defused sentinels it happened to contain.
function displayWidth(text: string): number {
  return Array.from(text.split(ZERO_WIDTH_SPACE).join("")).length;
}

// Greedy wrap of ONE existing line. Every line it emits is a contiguous slice of
// its input, and the only characters it ever drops are the whitespace run a break
// replaces, so every newline-free substring of the output is one of the input's.
// That is the safety argument: a break cannot rebuild a sweep sentinel
// defuseSweepSentinels already removed, and cannot manufacture the literal space
// `\d Pending` matches on -- it only ever removes one.
function wrapLine(line: string): string {
  if (displayWidth(line) <= GREENLIGHT_MESSAGE_WRAP_WIDTH) {
    return line;
  }
  // Odd indices are whitespace runs, even indices the words between them; only
  // the first and last of those can be empty, since `\s+` is greedy.
  const segments = line.split(/(\s+)/);
  const wrapped: string[] = [];
  let current = segments[0];
  for (let i = 1; i < segments.length; i += 2) {
    const word = segments[i + 1] ?? "";
    const candidate = `${current}${segments[i]}${word}`;
    // A word wider than the column on its own goes out intact: chopping a URL or
    // a sha makes it silently wrong when copied, while an over-wide line is only
    // ugly. Breaking here would also emit a blank or whitespace-only line.
    const unbreakable = word === "" || current.trim() === "";
    if (
      unbreakable ||
      displayWidth(candidate) <= GREENLIGHT_MESSAGE_WRAP_WIDTH
    ) {
      current = candidate;
      continue;
    }
    wrapped.push(current);
    current = word;
  }
  wrapped.push(current);
  return wrapped.join("\n");
}

// Each existing line is wrapped on its own, never reflowed into its neighbours:
// the model's paragraph breaks and blank lines are the only structure the reader
// gets inside a fence, and a message already narrow enough comes out untouched.
function wrapMessage(text: string): string {
  return text.split("\n").map(wrapLine).join("\n");
}

// Cap, neutralize @-mentions so the comment cannot ping anyone or issue a bot
// command, hard-wrap, then seal the result in a fence longer than any backtick
// run it contains so it cannot break out of the block. Same defanging as
// comment_format.defang, plus the wrap. Deliberately NOT HTML-escaped -- the
// fence is the containment, and escaping inside it would render `&amp;`
// literally to the reader.
export function defangGreenlightMessage(text: string): string {
  // Capping before the wrap is what makes 4000 mean 4000 characters the model
  // wrote: a break swallows the whitespace run it replaces, so wrapping first
  // would shrink the text and let a different amount of it through.
  const capped = capCodePoints(text || "", GREENLIGHT_MESSAGE_CAP);
  const neutralized = capped.split("@").join(`@${ZERO_WIDTH_SPACE}`);
  // Breaks land only on whitespace and a backtick run holds none, so the wrap
  // leaves every run intact and this is the same fence either side of it. What
  // the wrap does change is position: a run that was mid-line can end up at the
  // start of one, where only a run at least as long as the fence could close the
  // block -- and the fence is longer than every run in the text by construction.
  const runs = neutralized.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${wrapMessage(neutralized)}\n${fence}`;
}

// Which renderer a row goes through is decided per row, never per deploy. The
// fence is the render for prose, not a fallback from a failed one: nothing
// enforces the outline shape, so a paragraph is a valid verdict and reads better
// fenced than forced into a one-item bullet list. Stored rows keep the path alive
// independently of that -- this section's query has no time filter and the scan
// writes no newer row once a PR is human-decided, ages out or is labelled Stale,
// so a verdict recorded before the outline format existed re-renders on every
// later sweep. Either reason alone obliges both renderers to stay.
//
// renderOutlineHtml escapes, defuses and contains its own output, so neither the
// defuse nor the fence may run over it: a fence would show its tags verbatim.
// Every way it declines to produce a block reaches the fence -- "" when every
// leaf flattened away or the first item alone overruns the budget, and a throw
// from its containment tripwire, which must not propagate: the next handler up
// is the per-row catch in greenlightComment.ts, which drops this PR's section
// outright, so a verdict that exists -- and that the fence renders correctly --
// would show its author nothing at all. Catching here costs the reader the
// bullet list and keeps the verdict. Classifying the message is inside the guard
// for the same reason -- it reads the same untrusted text the renderer does. The
// log gets the PR number and the error, never the message -- untrusted model
// output, scrubbed for the comment and not for the log.
function renderVerdictMessage(message: string, prNumber: number): string {
  const text = message || "";
  let outline = "";
  try {
    if (isOutline(text)) {
      outline = renderOutlineHtml(text);
    }
  } catch (e) {
    console.error("greenlight outline render threw for PR", prNumber, e);
  }
  return outline || defangGreenlightMessage(defuseSweepSentinels(text));
}

// Nothing may DELETE a character after the defuse: a deletion splices the text on
// either side of it together, and `alt="Green Light: in` + a backtick +
// ` progress"` carries no sentinel for defuseSweepSentinels to find yet becomes
// one the instant inlineCode strips that backtick. Defusing the finished line,
// rather than the reason on its way into it, is what keeps that true whatever
// inlineCode is made to delete later -- shortSha calls it too, so it can be
// widened for reasons that never look at this line. The prefix and the backticks
// the defuse now also covers hold no sentinel, so the wider reach changes nothing
// it emits. Every reason the renderer shows is built here, constants included, so
// no second path can grow that defuses differently, or not at all.
function reasonLine(reason: string): string {
  return defuseSweepSentinels(`reason: ${inlineCode(reason || "")}`);
}

function renderSection(
  headline: string,
  bodyLines: string[],
  evalJob: string,
  inProgress: boolean,
  outdated: boolean
): string {
  const lines = [...bodyLines];
  if (SAFE_JOB_URL_RE.test(evalJob)) {
    lines.push("", `[Inference job](${evalJob})`);
  }
  const marker = inProgress ? `${GREENLIGHT_PENDING_MARKER}\n` : "";
  // The section renders closed, so the <summary> is all a reader sees without
  // expanding: the outdated marker belongs on it, never in bodyLines.
  const summary = outdated
    ? `${GREENLIGHT_OUTDATED_HEADLINE_PREFIX}${headline}`
    : headline;
  // Two newlines after <p> so the markdown body below is parsed as markdown
  // rather than raw HTML, matching constructResultsJobsSections in drci.ts.
  return (
    `\n${marker}<details><summary><b>${GREENLIGHT_SECTION_HEADER}</b> - ${summary}:</summary><p>\n\n` +
    `${lines.join("\n")}\n\n` +
    `</p></details>`
  );
}

// `currentHeadSha` is the PR's head at render time, which the verdict's own
// headSha can lag behind indefinitely; see GREENLIGHT_OUTDATED_HEADLINE_PREFIX.
// Returns "" for any state that has no section to show (an unknown status);
// callers treat empty as "no Green Light section".
export function renderGreenlightSection(
  state: GreenlightState,
  now: Date,
  currentHeadSha: string
): string {
  const status = (state.status || "").trim();
  const evalJob = (state.evalJob || "").trim();
  const outdated = isOutdatedVerdict(state.headSha, currentHeadSha);
  const commitLines = reviewedCommitLines(state.headSha, currentHeadSha);

  if (
    status === GREENLIGHT_STATUS_LAND ||
    status === GREENLIGHT_STATUS_NO_LAND
  ) {
    const headline =
      status === GREENLIGHT_STATUS_LAND
        ? GREENLIGHT_LAND_HEADLINE
        : GREENLIGHT_NO_LAND_HEADLINE;
    const message = renderVerdictMessage(state.message, state.prNumber);
    return renderSection(
      headline,
      [message, "", reasonLine(state.reason), ...commitLines],
      evalJob,
      false,
      outdated
    );
  }

  // A revert excludes the PR outright rather than judging one commit: it holds
  // for the current head and every later one, and the row carries no reason,
  // message or job of its own. Both the outdated marker and the reviewed-commit
  // line would frame it as superseded by the next push, which is the one reading
  // that leaves an author waiting on a re-review that never comes.
  if (status === GREENLIGHT_STATUS_REVERTED) {
    return renderSection(
      GREENLIGHT_REVERTED_HEADLINE,
      [GREENLIGHT_REVERTED_BODY],
      evalJob,
      false,
      false
    );
  }

  // AI_REVIEW_DISPATCHED is in-flight too, and the scan writes it without poking
  // Dr.CI, so the sentinel emitted here is the only thing that keeps the sweep
  // re-rendering a PR whose reviewer never announced its start.
  if (
    status === GREENLIGHT_STATUS_AI_REVIEW_STARTED ||
    status === GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED
  ) {
    if (isInProgressStale(state.version, now)) {
      return renderSection(
        GREENLIGHT_INCOMPLETE_HEADLINE,
        [reasonLine(GREENLIGHT_STALLED_REASON), ...commitLines],
        evalJob,
        false,
        outdated
      );
    }
    return renderSection(
      GREENLIGHT_REVIEWING_HEADLINE,
      [GREENLIGHT_REVIEWING_BODY, ...commitLines],
      evalJob,
      true,
      outdated
    );
  }

  // Mirrors comment_format.marker_body: the retry statuses render their
  // lowercased name as the human-readable reason.
  if (
    status === GREENLIGHT_STATUS_CANCELLED ||
    status === GREENLIGHT_STATUS_FAILED
  ) {
    return renderSection(
      GREENLIGHT_INCOMPLETE_HEADLINE,
      [reasonLine(status.toLowerCase()), ...commitLines],
      evalJob,
      false,
      outdated
    );
  }

  return "";
}
