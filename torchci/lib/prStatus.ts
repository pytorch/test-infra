// Pure rendering of the PR Status section of the Dr.CI comment.
//
// This is the one line a contributor should have to read to know what stage
// their PR is at and who owes the next step. It renders at the very top of the
// Dr.CI comment, above the Helpful Links header, so it is the first thing shown.
//
// The stage is derived from the PR's status labels plus its review state; the
// bots that APPLY those labels live elsewhere. This module only reports the
// stage, it never infers one the labels do not claim.
//
// Pure -- no Octokit, no ClickHouse -- so the stage logic and the exact
// contributor-facing strings are testable without mocking anything.

// The three mutually-exclusive status labels of the PR workflow. A PR carrying
// none of them has not been triaged yet and gets no section at all -- an empty
// render is how the Dr.CI comment stays unchanged for the repos and PRs this
// flow does not apply to.
export const PR_STATUS_LABEL_TRIAGED = "triaged";
export const PR_STATUS_LABEL_IN_PROGRESS = "in progress";
export const PR_STATUS_LABEL_READY_FOR_REVIEW = "ready for review";

export const PR_STATUS_LABELS = [
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
];

// Delimiters around the rendered section. The full-sweep render in drci.ts
// rebuilds the whole comment and does not need them, but the label-event path
// (lib/bot/prStatusBot.ts) splices this section into an existing comment in
// place -- rewriting the comment from scratch there would drop the CI results
// the sweep put in it. Both ends are needed: the section is not the last thing
// in the comment.
export const PR_STATUS_START = "<!-- pr-status-start -->";
export const PR_STATUS_END = "<!-- pr-status-end -->";

// GitHub logins and team slugs are alphanumeric plus hyphen (teams also allow
// underscores), so anything else in a reviewer name did not come from GitHub.
// Dropping those rather than escaping them keeps the @-mention list from being
// a way to inject markdown, HTML, or a sweep predicate into the comment body.
const SAFE_REVIEWER_RE = /^[A-Za-z0-9-]+(\/[A-Za-z0-9_-]+)?$/;

export type PrStatusStage =
  | "approved"
  | "readyForReview"
  | "inProgress"
  | "preReview"
  | "none";

export interface PrStatusState {
  // The PR's current labels, as fetched for the Dr.CI comment.
  labels: string[];
  // Whether the PR currently carries a live approving review.
  isApproved: boolean;
  // The reviewers assigned to the PR, without the leading "@". Teams are
  // "org/team". Only read in the preReview stage, where it may legitimately be
  // empty -- a triaged PR with no reviewer assigned yet renders the message
  // with an empty list rather than hiding the stage the PR is actually in.
  //
  // Deliberately NOT filtered down to reviewers who have yet to react: GitHub
  // emits no webhook for reactions, so a list defined that way could stay wrong
  // indefinitely. See the note above fetchPrStatusState.
  assignedReviewers: string[];
}

// Approval outranks every label: it is a statement about the PR made by a
// maintainer, whereas the labels are bot-maintained and can lag a review by a
// sweep. Below it the labels are checked most-advanced first so a PR that
// briefly carries two of them (a bot mid-transition) reports the later stage
// rather than flapping back.
export function getPrStatusStage(state: PrStatusState): PrStatusStage {
  const labels = new Set(state.labels);
  if (state.isApproved) {
    return "approved";
  }
  if (labels.has(PR_STATUS_LABEL_READY_FOR_REVIEW)) {
    return "readyForReview";
  }
  if (labels.has(PR_STATUS_LABEL_IN_PROGRESS)) {
    return "inProgress";
  }
  if (labels.has(PR_STATUS_LABEL_TRIAGED)) {
    return "preReview";
  }
  return "none";
}

// Whether this PR needs the (GitHub-API-backed) inputs that getPrStatusStage
// cannot get from labels alone. Callers use it to skip those fetches entirely
// for the PRs -- the large majority -- that are not in the workflow yet.
export function hasPrStatusLabel(labels: string[]): boolean {
  return PR_STATUS_LABELS.some((label) => labels.includes(label));
}

function formatReviewers(assignedReviewers: string[]): string {
  return assignedReviewers
    .filter((reviewer) => SAFE_REVIEWER_RE.test(reviewer))
    .map((reviewer) => `@${reviewer}`)
    .join(", ");
}

// The message bodies below are quoted verbatim from the contributor-workflow
// spec and are contributor-facing policy, not implementation detail. Change
// them only alongside the matching section of CONTRIBUTING.md.
export function getPrStatusMessage(state: PrStatusState): string {
  switch (getPrStatusStage(state)) {
    case "approved":
      return (
        "PR Status: Approved 🚀. Please fix all CI failures and manually " +
        'request merge by commenting "@pytorchbot merge".'
      );
    case "readyForReview":
      return (
        "PR Status: ready for maintainer review. Please address comments " +
        "left by our maintainers until the PR is accepted."
      );
    case "inProgress":
      return "PR Status: in progress.";
    case "preReview":
      return (
        `PR Status: in pre-review. All assigned reviewers ` +
        `(${formatReviewers(state.assignedReviewers)}) must agree by ` +
        `reacting to the PR description that this change is worth pursuing ` +
        `before the PR will be marked "in progress".`
      );
    case "none":
      return "";
  }
}

// Returns "" when the PR is not in the workflow; callers treat empty as "no PR
// Status section", and the splice helpers treat it as "remove any existing one"
// so a label being taken off a PR clears the line rather than stranding it.
export function renderPrStatusSection(state: PrStatusState): string {
  const message = getPrStatusMessage(state);
  if (!message) {
    return "";
  }
  // A GitHub alert callout rather than a plain line: this has to stay legible
  // as the one "what do I do next" signal even as the comment below it grows.
  return `${PR_STATUS_START}\n> [!NOTE]\n> ${message}\n${PR_STATUS_END}\n`;
}

// The half-open [start, end) range a rendered section occupies in a comment
// body, or null if there is no terminated one. `end` swallows the newline the
// section carries after its end marker, so cutting the range out leaves a body
// byte-identical to one rendered without a section -- which is what keeps the
// splice and the full render in agreement.
function findSectionSpan(body: string): { start: number; end: number } | null {
  const start = body.indexOf(PR_STATUS_START);
  if (start === -1) {
    return null;
  }
  const marker = body.indexOf(PR_STATUS_END, start + PR_STATUS_START.length);
  if (marker === -1) {
    return null;
  }
  const end = marker + PR_STATUS_END.length;
  return { start, end: body[end] === "\n" ? end + 1 : end };
}

/**
 * The PR Status section already present in a comment body, markers and trailing
 * newline included, or "" if there is none (or only an unterminated one).
 *
 * Lets a caller that rebuilds the comment from scratch carry the existing
 * section across rather than dropping it. `upsertDrCiComment` needs this: it
 * renders on push with no status inputs of its own, and would otherwise delete
 * the line on every commit until the next sweep put it back.
 */
export function extractPrStatusSection(body: string): string {
  const span = findSectionSpan(body);
  return span ? body.slice(span.start, span.end) : "";
}

// A comment body with no PR Status section in it.
//
// The unterminated case is a body GitHub truncated, or a half-written one.
// There is no end marker to cut to, so the start marker AND the callout lines
// after it are dropped: removing only the marker would strand the half-written
// callout for good, with every later splice stacking a complete one above the
// fragment. Everything a section emits between its markers is a `>` line, so
// that run is exactly the orphan's body and the first line that is not one is
// content this must not touch.
function removePrStatusSection(body: string): string {
  const span = findSectionSpan(body);
  if (span) {
    return body.slice(0, span.start) + body.slice(span.end);
  }
  const start = body.indexOf(PR_STATUS_START);
  if (start === -1) {
    return body;
  }
  return (
    body.slice(0, start) +
    body.slice(start + PR_STATUS_START.length).replace(/^\n(?:>[^\n]*\n?)*/, "")
  );
}

/**
 * Replace the PR Status section of an existing Dr.CI comment body in place,
 * leaving everything else -- notably the CI results the sweep rendered --
 * untouched. Used by the label-event path, which must not rebuild the comment.
 *
 * Remove-then-insert rather than replace-in-place, because there is only one
 * position a section may occupy: immediately after `insertAfter`, the Dr.CI
 * start marker, which is where formDrciComment puts it. Replacing in place would
 * be the same operation on every well-formed body and would faithfully preserve
 * a section sitting somewhere it should not be. The marker is passed in rather
 * than imported so this module stays off the server-only drciUtils import chain.
 *
 * An empty `section` therefore means "remove", and a body with no marker at all
 * is not a Dr.CI comment and is returned as-is.
 */
export function splicePrStatusSection(
  body: string,
  section: string,
  insertAfter: string
): string {
  const base = removePrStatusSection(body);
  if (!section) {
    return base;
  }
  const marker = base.indexOf(insertAfter);
  if (marker === -1) {
    return base;
  }
  const at = marker + insertAfter.length;
  return base.slice(0, at) + section + base.slice(at);
}
