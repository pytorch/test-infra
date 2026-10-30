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
import { getFilesChangedByPr, isPyTorchPyTorch } from "lib/bot/utils";
import {
  fetchMergeRules,
  fetchTeamMembership,
} from "lib/greenlight/greenlightEligibility";
import {
  getApprovalStatusFromReviews,
  getApprovingReviewers,
  PR_APPROVED,
  PR_CHANGES_REQUESTED,
} from "lib/reviewApproval";
import { Octokit } from "octokit";

// The three mutually-exclusive status labels of the PR workflow. A PR carrying
// none of them has not been triaged yet and gets no section at all -- an empty
// render is how the Dr.CI comment stays unchanged for the repos and PRs this
// flow does not apply to.
export const PR_STATUS_LABEL_TRIAGED = "triaged";
export const PR_STATUS_LABEL_IN_PROGRESS = "in progress";
export const PR_STATUS_LABEL_READY_FOR_REVIEW = "ready for review";
// Skips automated review, so the PR goes to ready for review instead of in
// progress.
export const PR_STATUS_LABEL_REVIEW_OPT_OUT = "no automated review";
// Added by Auto PR Triage, together with triaged, when the PR links neither an
// actionable issue nor a supporting maintainer.
export const PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE =
  "missing actionable issue";

export const PR_STATUS_LABELS = [
  // Uncomment the following line post-rollout + change ln 166 to true in test
  // PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
];

// Set to the rollout date
export const PRE_REVIEW_START_DATE: string | null = "2026-09-01";

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
  | "needsAdditionalApproval"
  | "readyForReview"
  | "inProgress"
  | "missingActionableIssue"
  | "preReview"
  | "none";

export interface PrStatusState {
  // The PR's current labels, as fetched for the Dr.CI comment.
  labels: string[];
  // Whether the PR currently carries a live approving review.
  isApproved: boolean;
  // Whether an approving reviewer satisfies .github/merge_rules.yaml for the
  // changed files. Undefined when unknown, which reports a plain approval.
  isMergeApproved?: boolean;
  // Whether an authorized reviewer has an outstanding request for changes.
  hasChangesRequested?: boolean;
  // The reviewers assigned to the PR, without the leading "@". Teams are
  // "org/team". Only read in the preReview stage, where it may legitimately be
  // empty -- a triaged PR with no reviewer assigned yet renders the message
  // with an empty list rather than hiding the stage the PR is actually in.
  //
  // Deliberately NOT filtered down to reviewers who have yet to react: GitHub
  // emits no webhook for reactions, so a list defined that way could stay wrong
  // indefinitely. See the note above fetchPrStatusState.
  assignedReviewers: string[];
  // True when the PR lookup failed, so assignedReviewers only has people who
  // already reviewed.
  reviewerLookupFailed?: boolean;
}

// Approval outranks every label: it is a statement about the PR made by a
// reviewer, whereas the labels are bot-maintained and can lag a review by a
// sweep. An approval that no merge rule accepts still needs a maintainer, so
// it does not hide a missing actionable issue. Below it the labels are checked
// most-advanced first so a PR that briefly carries two of them (a bot
// mid-transition) reports the later stage.
// During a move back to in progress, this temporarily reports ready for review
// until the bot removes that label; the next live read reports in progress.
export function getPrStatusStage(state: PrStatusState): PrStatusStage {
  const labels = new Set(state.labels);
  if (state.isApproved && state.isMergeApproved !== false) {
    return "approved";
  }
  if (
    state.isApproved &&
    !labels.has(PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE)
  ) {
    return "needsAdditionalApproval";
  }
  if (labels.has(PR_STATUS_LABEL_READY_FOR_REVIEW)) {
    return "readyForReview";
  }
  if (labels.has(PR_STATUS_LABEL_IN_PROGRESS)) {
    return "inProgress";
  }
  // Checked before triaged, which Auto PR Triage adds alongside it.
  if (labels.has(PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE)) {
    return "missingActionableIssue";
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
    case "needsAdditionalApproval":
      return (
        "## PR Status: Needs additional approval\n\n" +
        "This PR is missing an approval from someone with merge rights " +
        "for the code paths it changes."
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
        (state.hasChangesRequested
          ? "A maintainer requested changes. Please address their feedback " +
            "before the PR returns to maintainer review.\n\n"
          : "The overall direction of the change is good.\n\n") +
        "To become ready for review, the change must pass automated review " +
        "and every maintainer comment must be addressed, either with a code " +
        "change or a reply explaining why no change is needed. A fresh " +
        "automated review checks that the feedback has been addressed. All " +
        "CI must finish and Dr. CI must classify every failure as unrelated " +
        "to your PR. Fix the failures it attributes to your PR (see status " +
        "below in this comment). Workflows waiting for a maintainer to " +
        "approve their run do not block this.\n\n" +
        "To minimize iteration time, feel free to run the pr-review " +
        "skill from the repo locally. If you address comments without " +
        "pushing, comment `@pytorchbot review` to re-run the automated " +
        "review. To bypass automated review, please add the “no automated " +
        "review” label."
      );
    case "missingActionableIssue":
      return (
        "## PR Status: missing actionable issue\n\n" +
        "Auto PR Triage did not find either of the following when it " +
        "checked this PR:\n\n" +
        "- a linked issue labeled `actionable` (`Fixes #<issue>` or " +
        "`Part of #<issue>`); or\n" +
        "- a maintainer named in the description who agreed to the change " +
        "(`Supported by @<maintainer>`).\n\n" +
        "Such PRs are a low priority for maintainers to review and might not " +
        "get a response given the very high volume of PRs we receive. " +
        "Please focus on `actionable` issues to ensure a maintainer will be " +
        "available to review your PR.\n\n" +
        "If one of these applies, add the matching line to the PR " +
        "description. If there is no `actionable` issue for this change " +
        "yet, you can open one (or comment on an existing one) and wait for " +
        "a maintainer to label it `actionable`. Then ask a maintainer to " +
        "triage the PR again: they remove the `triaged`, `bot-triaged`, and " +
        "`missing actionable issue` labels, then remove and re-add " +
        "`open source`."
      );
    case "preReview":
      return (
        `## PR Status: in pre-review\n\n` +
        `Assigned reviewers (${formatReviewers(state.assignedReviewers)}) ` +
        `have one week after entering pre-review to accept with a thumbs-up on the PR ` +
        `description or \`@pytorchbot pre-review accept\`, or object with a ` +
        `thumbs-down. After that week, silence counts as acceptance. ` +
        `Outstanding requests for changes also block acceptance. ` +
        `Once everyone accepts or times out without an objection, ` +
        `the PR is marked "in progress".`
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

/** Fetches current labels, including every page, rather than webhook snapshots. */
export async function fetchLiveLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return labels.map((label) => label.name);
}

// Mirrors trymerge's find_matching_merge_rule: an approval counts for a rule
// whose patterns match every changed file and that names the approver, or
// names no approvers at all. trymerge reads approvers over GraphQL, where an
// app's login lacks the "[bot]" suffix REST gives it (merge_rules.yaml names
// "pytorchgreenlight", reviews come back from "pytorchgreenlight[bot]").
async function hasMergeRuleApproval(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  approvers: string[]
): Promise<boolean> {
  const [rules, files] = await Promise.all([
    fetchMergeRules(octokit),
    getFilesChangedByPr(octokit, owner, repo, prNumber),
  ]);
  const logins = approvers.map((approver) => approver.replace(/\[bot\]$/, ""));
  for (const rule of rules) {
    if (rule.matches === null || !files.every(rule.matches)) {
      continue;
    }
    if (rule.logins.length === 0 && rule.teams.length === 0) {
      return true;
    }
    for (const login of logins) {
      if (rule.logins.includes(login)) {
        return true;
      }
      for (const team of rule.teams) {
        if (await fetchTeamMembership(octokit, team, login)) {
          return true;
        }
      }
    }
  }
  return false;
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

  const approvalStatus = getApprovalStatusFromReviews(
    reviews as any,
    isPyTorchPyTorch(owner, repo)
  );

  // The merge rules are pytorch/pytorch's, so only its approvals are checked.
  let isMergeApproved: boolean | undefined;
  if (approvalStatus === PR_APPROVED && isPyTorchPyTorch(owner, repo)) {
    try {
      isMergeApproved = await hasMergeRuleApproval(
        octokit,
        owner,
        repo,
        prNumber,
        getApprovingReviewers(reviews as any, true)
      );
    } catch (e) {
      console.warn(
        `fetchPrStatusState: merge rule lookup failed for ${owner}/${repo}#${prNumber}`,
        e
      );
    }
  }

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

  return {
    labels,
    isApproved: approvalStatus === PR_APPROVED,
    isMergeApproved,
    hasChangesRequested: approvalStatus === PR_CHANGES_REQUESTED,
    assignedReviewers,
    reviewerLookupFailed: pullResult.status === "rejected",
  };
}
