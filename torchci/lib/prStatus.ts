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
import type { PreReviewStatus } from "lib/bot/preReviewUtils";
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
  PR_STATUS_LABEL_TRIAGED,
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
// Dropping those rather than escaping them keeps the reviewer list from being
// a way to inject markdown, HTML, or a sweep predicate into the comment body.
const SAFE_REVIEWER_RE = /^[A-Za-z0-9-]+(\/[A-Za-z0-9_-]+)?$/;

export type PrStatusStage =
  | "draft"
  | "approved"
  | "needsAdditionalApproval"
  | "readyForReview"
  | "inProgress"
  | "missingActionableIssue"
  | "preReview"
  | "none";

export interface PrStatusState {
  authorLogin?: string;
  pullRequest?: { state?: string; draft?: boolean; created_at?: string };
  // Outstanding requests from the same live PR read, for final-review reminders.
  requestedReviewers?: string[];
  preReview?: PreReviewStatus;
  // The PR's current labels, as fetched for the Dr.CI comment.
  labels: string[];
  // Whether the PR currently carries a live approving review.
  isApproved: boolean;
  // Whether an approving reviewer satisfies .github/merge_rules.yaml for the
  // changed files. Undefined if verification failed or this repository does
  // not use PyTorch's merge rules; the failure flag distinguishes the two.
  isMergeApproved?: boolean;
  mergeApprovalLookupFailed?: boolean;
  // Whether an authorized reviewer has an outstanding request for changes.
  hasChangesRequested?: boolean;
  // The reviewers assigned to the PR, without the leading "@". Teams are
  // "org/team". Only read in the preReview stage, where it may legitimately be
  // empty -- a triaged PR with no reviewer assigned yet renders the message
  // explicitly rather than hiding the stage the PR is actually in.
  // The preReview snapshot divides these into accepted, silent and objecting
  // reviewers. Its periodic refresh also catches reactions without webhooks.
  assignedReviewers: string[];
  // True when the PR lookup failed, so assignedReviewers only has people who
  // already reviewed.
  reviewerLookupFailed?: boolean;
}

// A verified merge approval outranks the workflow labels, which can lag a
// review by a sweep. Other approvals cannot hide pre-review or a missing
// actionable issue. Drafts take precedence over review status. Labels are checked
// most-advanced first so a PR that briefly carries two of them (a bot
// mid-transition) reports the later stage.
// During a move back to in progress, this temporarily reports ready for review
// until the bot removes that label; the next live read reports in progress.
export function getPrStatusStage(state: PrStatusState): PrStatusStage {
  const labels = new Set(state.labels);
  if (state.pullRequest?.draft) {
    return "draft";
  }
  // An approval outside the merge rules does not end pre-review, and must not
  // hide its remaining reviewers or deadline. Unknown merge rights do not
  // constitute the verified approval that lets the pre-review sweep skip a PR.
  if (
    hasPreReviewLabels(state.labels) &&
    !(state.isApproved && state.isMergeApproved === true)
  ) {
    if (
      PRE_REVIEW_START_DATE === null ||
      (state.pullRequest?.created_at !== undefined &&
        Date.parse(state.pullRequest.created_at) <
          Date.parse(PRE_REVIEW_START_DATE))
    ) {
      return "none";
    }
    return "preReview";
  }
  if (
    state.isApproved &&
    state.isMergeApproved !== false &&
    !state.mergeApprovalLookupFailed
  ) {
    return "approved";
  }
  if (
    state.isApproved &&
    !state.mergeApprovalLookupFailed &&
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
  return "none";
}

export function hasPreReviewLabels(labels: string[]): boolean {
  return (
    labels.includes(PR_STATUS_LABEL_TRIAGED) &&
    !labels.includes(PR_STATUS_LABEL_IN_PROGRESS) &&
    !labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    !labels.includes(PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE)
  );
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
    .map((reviewer) => `\`${reviewer}\``)
    .join(", ");
}

function getPreReviewMessage(status?: PreReviewStatus): string {
  const heading =
    "## PR Status: in pre-review\n\n" +
    "Pre-review is a quick check of the PR's overall direction before " +
    "automated and detailed maintainer review; it does not grant merge approval. " +
    "Assigned reviewers can pre-accept with a 👍 on the PR description or a " +
    "`@pytorchbot pre-review accept` comment, or request changes with a 👎 " +
    "on the PR description.\n\n";
  if (!status || status.lookupFailed) {
    return (
      heading +
      "Pre-review responses or the reviewer list could not be checked yet. " +
      "The bot will retry; this does not count as acceptance."
    );
  }
  const lines: string[] = [];
  const silent = status.pending.filter(
    (reviewer) => !status.rejected.includes(reviewer)
  );
  if (silent.length) {
    lines.push(`**Waiting for pre-review:** ${formatReviewers(silent)}.`);
  }
  if (status.agreed.length) {
    lines.push(`**Pre-review accepted:** ${formatReviewers(status.agreed)}.`);
  }
  if (status.rejected.length) {
    lines.push(
      `**Pre-review request changes:** ${formatReviewers(status.rejected)}. ` +
        "These block pre-review and do not expire. Address the feedback; " +
        "the reviewer must remove their thumbs-down, or the change request " +
        "must be approved or dismissed."
    );
  }
  if (!status.assigned.length) {
    lines.push("No reviewers are assigned; the shared deadline still applies.");
  }
  if (status.expiresAt) {
    const timestamp = status.expiresAt
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, " UTC");
    lines.push(
      `**Pre-review deadline:** ${timestamp}. ` +
        (status.deadlinePassed
          ? "This deadline has passed; reviewers who did not respond no longer block pre-review."
          : "Reviewers who have not responded by then no longer block pre-review. " +
            "Adding reviewers does not extend this deadline.")
    );
  } else {
    lines.push(
      "**Pre-review deadline:** unavailable because the entry time could not " +
        "be determined. The bot will retry; unanswered requests still block " +
        "until the deadline is known."
    );
  }
  if (status.accepted) {
    lines.push(
      'Pre-review is complete; the bot will mark this PR "in progress".'
    );
  }
  lines.push(
    "Progress refreshes on bot checks, including the scheduled check every " +
      "15 minutes. Unchanged PRs with objections are rechecked every six hours."
  );
  return heading + lines.join("\n\n");
}

// Contributor-facing explanations of the workflow. The pre-review details use
// the same snapshot as the advancement policy, including team responses.
export function getPrStatusMessage(state: PrStatusState): string {
  const message = getPrStatusStageMessage(state);
  if (
    !message ||
    !state.mergeApprovalLookupFailed ||
    state.pullRequest?.draft
  ) {
    return message;
  }
  return (
    message +
    "\n\nAn approval was received, but merge eligibility could not be verified. " +
    "The bot will retry; this approval does not yet mark the PR ready to merge."
  );
}

function getPrStatusStageMessage(state: PrStatusState): string {
  switch (getPrStatusStage(state)) {
    case "draft":
      return (
        "## PR Status: draft\n\n" +
        "This PR is waiting for its author to mark it ready for review. " +
        "Pre-review does not advance while the PR is a draft."
      );
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
        (state.hasChangesRequested
          ? "A maintainer requested changes. Please address their feedback " +
            "and ask for another review."
          : "Waiting for a maintainer with merge rights for the changed paths " +
            "to review this PR. Please address any feedback they leave.")
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
        "a maintainer to label it `actionable`. Adding `actionable` to an " +
        "already-linked issue automatically requests re-triage of open, " +
        "non-draft PRs with `open source` and " +
        "`missing actionable issue`, unless automated triage is disabled. " +
        "Adding a valid actionable-issue link or `Supported by` line to " +
        "the description also requests re-triage automatically. Marking " +
        "the PR ready, reopening it, or re-enabling automated triage " +
        "rechecks existing links and support. If re-triage is still needed, " +
        "ask a maintainer: they remove the `triaged`, " +
        "`bot-triaged`, and `missing actionable issue` labels, then " +
        "remove and re-add `open source`."
      );
    case "preReview":
      return getPreReviewMessage(state.preReview);
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
 * Fetches approval and current PR metadata for every workflow stage, plus
 * reviewer assignments for triaged PRs. Draft status cannot be inferred from
 * labels: a draft may carry any workflow label, including no triaged label.
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
  const [reviewsResult, pullResult] = await Promise.allSettled([
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    hasPrStatusLabel(labels)
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
  const liveLabels = pull?.data.labels?.map((label) => label.name) ?? labels;

  const approvalStatus = getApprovalStatusFromReviews(
    reviews as any,
    isPyTorchPyTorch(owner, repo)
  );

  // The merge rules are pytorch/pytorch's, so only its approvals are checked.
  let isMergeApproved: boolean | undefined;
  let mergeApprovalLookupFailed = false;
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
      mergeApprovalLookupFailed = true;
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
    liveLabels.includes(PR_STATUS_LABEL_TRIAGED) && author
      ? buildAssignedReviewers(
          owner,
          pull?.data.requested_reviewers ?? [],
          pull?.data.requested_teams ?? [],
          reviews as any,
          author
        )
      : [];

  return {
    labels: liveLabels,
    authorLogin: author,
    requestedReviewers: pull
      ? buildAssignedReviewers(
          owner,
          pull.data.requested_reviewers ?? [],
          pull.data.requested_teams ?? [],
          [],
          author ?? ""
        )
      : undefined,
    pullRequest: pull
      ? {
          state: pull.data.state,
          draft: pull.data.draft,
          created_at: pull.data.created_at,
        }
      : undefined,
    isApproved: approvalStatus === PR_APPROVED,
    isMergeApproved,
    mergeApprovalLookupFailed,
    hasChangesRequested: approvalStatus === PR_CHANGES_REQUESTED,
    assignedReviewers,
    reviewerLookupFailed: pullResult.status === "rejected",
  };
}
