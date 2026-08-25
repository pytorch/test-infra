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

import { ADVISOR_PENDING_ALT_ATTR } from "lib/advisor/advisorBadge";
import { isInProgressStale } from "lib/greenlight/greenlightStaleness";

export const GREENLIGHT_STATUS_LAND = "LAND";
export const GREENLIGHT_STATUS_NO_LAND = "NO_LAND";
export const GREENLIGHT_STATUS_AI_REVIEW_STARTED = "AI_REVIEW_STARTED";
export const GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED = "AI_REVIEW_DISPATCHED";
export const GREENLIGHT_STATUS_CANCELLED = "CANCELLED";
export const GREENLIGHT_STATUS_FAILED = "FAILED";

export const GREENLIGHT_LAND_HEADLINE =
  "PR approved to be merged without human review";
export const GREENLIGHT_NO_LAND_HEADLINE = "PR requires human review";
export const GREENLIGHT_REVIEWING_HEADLINE = "Green Light review in progress";
export const GREENLIGHT_INCOMPLETE_HEADLINE =
  "Green Light review did not complete";
export const GREENLIGHT_REVIEWING_BODY = "Green Light is reviewing this PR.";

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
export const ZERO_WIDTH_SPACE = "\u200b";

// GitHub does not soft-wrap inside a code fence, so an unwrapped verdict renders
// as one line behind a horizontal scrollbar. 80 is the conventional terminal and
// diff column: wide enough that wrapping a prose paragraph costs few lines,
// narrow enough to clear the PR conversation column on a narrow viewport.
// Readability only, and best-effort: a single word longer than this, or one
// padded out with zero-width spaces, goes out unwrapped. Nothing may rely on a
// rendered line being within the column.
export const GREENLIGHT_MESSAGE_WRAP_WIDTH = 80;

// The in-progress sentinel, shaped like the advisor's alt attribute (see
// ADVISOR_PENDING_ALT_ATTR in lib/advisor/advisorBadge.ts) so both AI surfaces
// in the comment are matched by the same cheap substring search. It is emitted
// ONLY while a review is live; every terminal render omits it, which is how the
// Dr.CI re-render candidate set self-clears once a verdict lands.
export const GREENLIGHT_PENDING_ALT = "Green Light: in progress";
export const GREENLIGHT_PENDING_ALT_ATTR = `alt="${GREENLIGHT_PENDING_ALT}"`;
// Greenlight has no badge image to hang the attribute on, so the sentinel rides
// an HTML comment: invisible once GitHub renders the body, but present in the
// raw comment text the candidate query greps (the same trick as
// `<!-- drci-comment-start -->`).
const GREENLIGHT_PENDING_MARKER = `<!-- greenlight ${GREENLIGHT_PENDING_ALT_ATTR} -->`;

// Every literal getPRsNeedingCommentRefresh (drci.ts) pins a PR into the sweep
// on. Those predicates run over the RAW comment body, and the greenlight message
// is the only model-authored text in it that is not HTML-escaped -- the fence in
// defangGreenlightMessage stops the text RENDERING as markup but leaves the
// characters themselves intact -- so a terminal render that carries one pins the
// PR into every sweep forever, defeating the self-clearing the sentinel design
// rests on.
export const SWEEP_SENTINELS = [
  GREENLIGHT_PENDING_ALT_ATTR,
  ADVISOR_PENDING_ALT_ATTR,
];
// The sweep's third predicate is the regex `\d Pending`, meant to match the
// comment's own "3 Pending" job count. Text merely describing the PR's CI state
// trips it with no adversary involved, so break the token rather than delete a
// word the reader needs.
const SWEEP_PENDING_WORD = "Pending";
const SWEEP_PENDING_WORD_DEFUSED = `P${ZERO_WIDTH_SPACE}ending`;
// Shortest raw-body text any of those predicates can match: both attributes are
// far longer than a `\d Pending` match, which is a digit and a space ahead of the
// word. Renderer output too short to reach this cannot carry a predicate however
// it is crafted, which is the only thing that lets a value skip the defuse.
export const SWEEP_PREDICATE_MIN_LENGTH = Math.min(
  ...SWEEP_SENTINELS.map((sentinel) => sentinel.length),
  SWEEP_PENDING_WORD.length + 2
);

// Rendered only when the URL cannot break out of the `[text](url)` link AND
// points at github.com. The host anchor has to be literal `github.com/`: a
// userinfo prefix (`https://u:p@github.com/`) and a lookalike host
// (`https://github.com.example/`) both satisfy a mere "contains github.com".
const SAFE_JOB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

// shortSha is the one rendered value that never reaches defuseSweepSentinels.
// What makes that safe is arithmetic: kept under SWEEP_PREDICATE_MIN_LENGTH, no
// sha it emits is long enough to spell a predicate, whatever the sha holds.
export const SHORT_SHA_LENGTH = 7;

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
  // Cap on code points, matching Python's `text[:4000]`; a UTF-16 slice would
  // both count astral characters twice and be able to cut a surrogate pair.
  // Capping before the wrap is what makes 4000 mean 4000 characters the model
  // wrote: a break swallows the whitespace run it replaces, so wrapping first
  // would shrink the text and let a different amount of it through.
  const capped = Array.from(text || "")
    .slice(0, GREENLIGHT_MESSAGE_CAP)
    .join("");
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

// Substituting a zero-width space for each sentinel, rather than deleting it, is
// what makes a single pass sufficient. No sentinel contains that character, so a
// surviving occurrence would have to lie wholly inside one fragment of a split
// that by construction has none: neither a nested forgery
// (`alt="Green alt="Green Light: in progress"Light: in progress"`) nor one
// sentinel spliced together across the gap left by removing another can
// reassemble, and no later substitution can put one back. Deleting would need a
// fixpoint loop instead, which is quadratic in the message length -- `message` is
// an unbounded ClickHouse String and the cap in defangGreenlightMessage is
// applied after this, so a deeply nested 600 KB payload blocks the event loop for
// seconds in a shared handler.
function defuseSweepSentinels(text: string): string {
  let out = text;
  for (const sentinel of SWEEP_SENTINELS) {
    out = out.split(sentinel).join(ZERO_WIDTH_SPACE);
  }
  return out.split(SWEEP_PENDING_WORD).join(SWEEP_PENDING_WORD_DEFUSED);
}

// Characters that would end an inline code span or the line holding it.
export const INLINE_BREAKERS_RE = /[`\r\n]/g;

function stripInlineBreakers(value: string): string {
  return value.replace(INLINE_BREAKERS_RE, "");
}

function inlineCode(value: string): string {
  return `\`${stripInlineBreakers(value)}\``;
}

// Whether the verdict was reached on something other than the PR's current head.
// A missing sha on either side means the comparison cannot be made, which is not
// evidence of a mismatch.
function isOutdatedVerdict(reviewedSha: string, currentSha: string): boolean {
  const reviewed = (reviewedSha || "").trim().toLowerCase();
  const current = (currentSha || "").trim().toLowerCase();
  return reviewed !== "" && current !== "" && reviewed !== current;
}

function shortSha(sha: string): string {
  return inlineCode(sha.trim().slice(0, SHORT_SHA_LENGTH));
}

function reviewedCommitLines(
  headSha: string,
  currentHeadSha: string
): string[] {
  const sha = (headSha || "").trim();
  if (!sha) {
    return [];
  }
  const line = `Reviewed commit: ${shortSha(sha)}`;
  if (!isOutdatedVerdict(sha, currentHeadSha)) {
    return [line];
  }
  return [`${line} (NOT the current head ${shortSha(currentHeadSha)})`];
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
    const message = defangGreenlightMessage(
      defuseSweepSentinels(state.message || "")
    );
    return renderSection(
      headline,
      [message, "", reasonLine(state.reason), ...commitLines],
      evalJob,
      false,
      outdated
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
