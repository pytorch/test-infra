// Pure rendering of the Green Light section of the Dr.CI comment, adapted from
// greenlight/src/greenlight/comment_format.py. It shares that module's status
// vocabulary and its defanging rules, so a misc.greenlight_pr_state row carries
// the same meaning whichever surface renders it -- but the two are deliberately
// not identical and are not meant to be kept so. Folding a row into the one Dr.CI
// comment is a different job from posting a standalone one: this side uses
// Dr.CI's open <details> scaffold rather than the CLI's collapsed one, names the
// commit the verdict was reached on, renders AI_REVIEW_DISPATCHED (scan-only, so
// the CLI never sees it), and has a stalled state for a terminal row that never
// arrived. No ClickHouse / Octokit / server-only imports, so this is
// unit-testable as-is.

import { ADVISOR_PENDING_ALT_ATTR } from "lib/advisor/advisorBadge";

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
const ZERO_WIDTH_SPACE = "\u200b";

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
const SWEEP_SENTINELS = [GREENLIGHT_PENDING_ALT_ATTR, ADVISOR_PENDING_ALT_ATTR];
// The sweep's third predicate is the regex `\d Pending`, meant to match the
// comment's own "3 Pending" job count. Text merely describing the PR's CI state
// trips it with no adversary involved, so break the token rather than delete a
// word the reader needs.
const SWEEP_PENDING_WORD = "Pending";
const SWEEP_PENDING_WORD_DEFUSED = `P${ZERO_WIDTH_SPACE}ending`;

// An AI_REVIEW_STARTED row older than this renders as "did not complete" rather
// than as a live review: the terminal emit was lost (the S3 -> ClickHouse
// replicator drops rows silently and never retries) and the row would otherwise
// show "in progress" forever.
// Sized off the longest real path from the in-flight row to the terminal one. The
// review job is capped at 40 minutes, bounding its 37-minute model step, and the
// record job that emits the verdict only starts after it; the worst prior-row age
// actually observed at record time is ~38 minutes. Deliberately WIDER than
// DEFAULT_TIMEOUT_MINUTES (45) in greenlight/constants.py, which is a different
// clock: that one governs when the scan re-dispatches, and a re-dispatch writes a
// row with a higher run_id that the greenlight_pr_states query prefers. So the
// extra width is only ever spent on a run nothing supersedes, while at 45 a
// queued runner was enough to call a review stalled that was about to finish.
export const GREENLIGHT_IN_PROGRESS_STALE_MS = 60 * 60 * 1000;

// Rendered only when the URL cannot break out of the `[text](url)` link AND
// points at github.com. The host anchor has to be literal `github.com/`: a
// userinfo prefix (`https://u:p@github.com/`) and a lookalike host
// (`https://github.com.example/`) both satisfy a mere "contains github.com".
const SAFE_JOB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

const SHORT_SHA_LENGTH = 7;

// ISO-shaped with an optional fractional part and NO zone designator.
const CLICKHOUSE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

export interface GreenlightState {
  prNumber: number;
  status: string;
  reason: string;
  message: string;
  headSha: string;
  evalJob: string;
  version: string;
}

// Faithful port of comment_format.defang: cap, neutralize @-mentions so the
// comment cannot ping anyone or issue a bot command, then wrap in a fence longer
// than any backtick run the text contains so it cannot break out of the block.
// Deliberately NOT HTML-escaped -- the fence is the containment, and escaping
// inside it would render `&amp;` literally to the reader.
export function defangGreenlightMessage(text: string): string {
  // Cap on code points, matching Python's `text[:4000]`; a UTF-16 slice would
  // both count astral characters twice and be able to cut a surrogate pair.
  const capped = Array.from(text || "")
    .slice(0, GREENLIGHT_MESSAGE_CAP)
    .join("");
  const neutralized = capped.split("@").join(`@${ZERO_WIDTH_SPACE}`);
  const runs = neutralized.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${neutralized}\n${fence}`;
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

function inlineCode(value: string): string {
  return `\`${value.replace(/[`\r\n]/g, "")}\``;
}

// ClickHouse serves this column under date_time_output_format='iso' (see
// lib/clickhouse.ts), which for DateTime64 emits `2026-08-24T21:57:40.736000` --
// ISO-shaped but carrying no zone designator, which Date.parse reads as LOCAL
// time and would shift the staleness window by the host's offset. The HUD
// ClickHouse server timezone is UTC, so build the epoch explicitly; the
// Date.parse fallback only sees forms that do carry a zone. NaN when unparseable.
function parseVersionMs(version: string): number {
  const trimmed = (version || "").trim();
  const parts = CLICKHOUSE_DATETIME_RE.exec(trimmed);
  if (parts === null) {
    return Date.parse(trimmed);
  }
  const millis = (parts[7] ?? "").slice(0, 3).padEnd(3, "0");
  return Date.UTC(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6]),
    Number(millis)
  );
}

// Mirrors decision._aged_out, including its treatment of a missing version as
// already aged out. Distance in either direction: a timestamp further ahead of
// now than the window is as implausible as one that far behind it, and treating
// it as fresh would render "in progress" -- and keep emitting the re-render
// sentinel -- for as long as the row stands. Comparing the magnitude rather than
// clamping every negative age keeps a few seconds of clock skew between the
// writer and the HUD from reading as a stalled review.
function isInProgressStale(version: string, now: Date): boolean {
  const versionMs = parseVersionMs(version);
  if (Number.isNaN(versionMs)) {
    return true;
  }
  return Math.abs(now.getTime() - versionMs) >= GREENLIGHT_IN_PROGRESS_STALE_MS;
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

function reasonLine(reason: string): string {
  return `reason: ${inlineCode(defuseSweepSentinels(reason || ""))}`;
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
  const summary = outdated
    ? `${GREENLIGHT_OUTDATED_HEADLINE_PREFIX}${headline}`
    : headline;
  // Two newlines after <p> so the markdown body below is parsed as markdown
  // rather than raw HTML, matching constructResultsJobsSections in drci.ts.
  return (
    `\n${marker}<details open><summary><b>${GREENLIGHT_SECTION_HEADER}</b> - ${summary}:</summary><p>\n\n` +
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
        [`reason: ${inlineCode(GREENLIGHT_STALLED_REASON)}`, ...commitLines],
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
      [`reason: ${inlineCode(status.toLowerCase())}`, ...commitLines],
      evalJob,
      false,
      outdated
    );
  }

  return "";
}
