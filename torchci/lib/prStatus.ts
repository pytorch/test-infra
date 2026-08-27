// Pure rendering of the PR Status section of the Dr.CI comment.
//
// This is the first section a contributor should read to know what stage their
// PR is at and who owes the next step. It renders above Helpful Links so it is
// the first thing shown in the Dr.CI comment.
//
// The stage is derived from pytorch/pytorch's status labels plus its review
// state; the bots that APPLY those labels live elsewhere. This module only
// reports the stage, it never infers one the labels do not claim.
//
// Rendering stays pure and testable; GitHub reads are isolated for fetching.

import { PullRequestReview } from "@octokit/webhooks-types";
import { isPyTorchPyTorch } from "lib/bot/utils";
import { getApprovalStatusFromReviews, PR_APPROVED } from "lib/reviewApproval";
import { Octokit } from "octokit";

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

// A PR participates only if it has one of the workflow labels. Callers check
// this before fetching reviews or assigned reviewers from GitHub, avoiding API
// requests for PRs outside the workflow.
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
        "## PR Status: Approved 🚀\n\n" +
        "Please fix all CI failures and trigger " +
        'merge by commenting "@pytorchbot merge".'
      );
    case "readyForReview":
      return (
        "## PR Status: ready for maintainer review\n\n" +
        "Please address comments " +
        "left by our maintainers until the PR is accepted."
      );
    case "inProgress":
      return (
        "## PR Status: in progress\n\n" +
        "The overall direction of the change is " +
        "good. The next step is to ensure the change passes the automated " +
        "review.\n\n" +
        "To minimize iteration time, feel free to run the pr-review " +
        "skill from the repo locally. The PR will be marked ready for " +
        "maintainer review when automated review passes. To bypass automated " +
        "review, please add the “no automated review” label."
      );
    case "preReview":
      return (
        `## PR Status: in pre-review\n\n` +
        `All assigned reviewers ` +
        `(${formatReviewers(state.assignedReviewers)}) must agree by ` +
        `reacting to the PR description that this change is worth pursuing ` +
        `before the PR will be marked "in progress".`
      );
    case "none":
      return "";
  }
}

// Returns no section for a PR outside the workflow. When a status label is
// removed, the splice helpers use this empty result to remove any stale section.
export function renderPrStatusSection(state: PrStatusState): string {
  const message = getPrStatusMessage(state);
  if (!message) {
    return "";
  }
  return `${PR_STATUS_START}\n${message}\n${PR_STATUS_END}\n`;
}

/**
 * Reads an existing status so a caller can preserve it while rebuilding the
 * rest of the Dr.CI comment. Includes the trailing newline and returns "" if
 * either marker is missing.
 */
export function extractPrStatusSection(body: string): string {
  const start = body.indexOf(PR_STATUS_START);
  if (start === -1) {
    return "";
  }
  const endMarker = body.indexOf(PR_STATUS_END, start + PR_STATUS_START.length);
  if (endMarker === -1) {
    return "";
  }
  const end = endMarker + PR_STATUS_END.length;
  return body.slice(start, body[end] === "\n" ? end + 1 : end);
}

/**
 * Updates the status without rebuilding the CI results around it. An empty
 * section removes the current status. A body without `insertAfter` is unchanged.
 */
export function splicePrStatusSection(
  body: string,
  section: string,
  insertAfter: string
): string {
  let base = body;
  const start = body.indexOf(PR_STATUS_START);
  if (start !== -1) {
    const existing = extractPrStatusSection(body);
    if (existing) {
      base = body.slice(0, start) + body.slice(start + existing.length);
    } else {
      // Do not leave a partial status behind when inserting its replacement.
      const nextSection = body.indexOf(
        "\n## ",
        start + PR_STATUS_START.length + 1
      );
      base =
        body.slice(0, start) +
        (nextSection === -1 ? "" : body.slice(nextSection + 1));
    }
  }
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

// Use live, webhook-backed data so status updates do not wait for the
// ClickHouse mirror or a later CI sweep. Callers limit these requests to PRs
// carrying workflow labels.

/**
 * Combines current reviewer requests with people who already responded, because
 * GitHub removes a user from `requested_reviewers` after any review. Teams
 * cannot be recovered after GitHub removes their request.
 */
export function buildAssignedReviewers(
  owner: string,
  requestedReviewers: { login?: string }[],
  requestedTeams: { slug?: string }[],
  reviews: PullRequestReview[],
  authorLogin: string
): string[] {
  // CONTRIBUTOR is excluded because a past contribution does not prove review
  // access.
  const ASSIGNABLE_REVIEWER_ASSOCIATIONS = ["COLLABORATOR", "MEMBER", "OWNER"];
  const users = requestedReviewers
    .map((user) => user?.login)
    .filter((login): login is string => Boolean(login));
  const reviewers = reviews
    .filter((review) =>
      ASSIGNABLE_REVIEWER_ASSOCIATIONS.includes(review.author_association)
    )
    .map((review) => review.user?.login)
    .filter(
      (login): login is string => Boolean(login) && login !== authorLogin
    );
  const teams = requestedTeams
    .map((team) => team?.slug)
    .filter((slug): slug is string => Boolean(slug))
    .map((slug) => `${owner}/${slug}`);
  return Array.from(new Set([...users, ...reviewers, ...teams]));
}

/**
 * Fetches approval for every stage and reviewer assignments for triaged PRs.
 * Returns null when reviews are unavailable so callers preserve current status.
 * A failed PR lookup still returns approval but may omit assigned reviewers.
 */
export async function fetchPrStatusState(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[],
  // Used to exclude the author from recovered reviewers if the PR lookup fails.
  authorLogin?: string
): Promise<PrStatusState | null> {
  const needsReviewers = labels.includes(PR_STATUS_LABEL_TRIAGED);

  const [reviewsResult, pullResult] = await Promise.allSettled([
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    needsReviewers
      ? octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
      : Promise.resolve(undefined),
  ]);

  if (pullResult.status === "rejected") {
    console.warn(
      `fetchPrStatusState: reviewer lookup failed for ${owner}/${repo}#${prNumber}`,
      pullResult.reason
    );
  }

  if (reviewsResult.status === "rejected") {
    console.warn(
      `fetchPrStatusState: review lookup failed for ${owner}/${repo}#${prNumber}`,
      reviewsResult.reason
    );
    return null;
  }

  const reviews = reviewsResult.value;
  const pull = pullResult.status === "fulfilled" ? pullResult.value : undefined;

  const isApproved =
    getApprovalStatusFromReviews(
      reviews as any,
      isPyTorchPyTorch(owner, repo)
    ) === PR_APPROVED;

  // Without a known author, omit recovered reviewers rather than risk listing
  // the author as responsible for reviewing their own PR.
  const author = authorLogin ?? pull?.data.user?.login;

  const assignedReviewers =
    needsReviewers && author
      ? buildAssignedReviewers(
          owner,
          pull?.data.requested_reviewers ?? [],
          pull?.data.requested_teams ?? [],
          reviews as any,
          author
        )
      : [];

  return { labels, isApproved, assignedReviewers };
}
