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

import { getFilesChangedByPr, isPyTorchPyTorch } from "lib/bot/utils";
import {
  fetchMergeRules,
  fetchTeamMembership,
} from "lib/greenlight/greenlightEligibility";
import {
  getApprovalStatusFromReviews,
  getApprovingReviewers,
  getOutstandingChangesReviewers,
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
// Adding this label starts an Auto PR Triage run.
export const AUTO_PR_TRIAGE_LABEL = "open source";
export const BOT_TRIAGED_LABEL = "bot-triaged";
export const BOT_TRIAGE_ERROR_LABEL = "bot-triage-error";
// Auto PR Triage leaves a PR with this label as is.
export const AUTO_PR_TRIAGE_OPT_OUT_LABEL = "no automated triage";

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
  | "triaged"
  | "none";

export interface PrStatusState {
  authorLogin?: string;
  pullRequest?: {
    state?: string;
    draft?: boolean;
    created_at?: string;
    headRef?: string;
  };
  // Outstanding requests from the same live PR read, for final-review reminders.
  requestedReviewers?: string[];
  // Outstanding changes reviewers who have actually been asked to review again.
  reReviewers?: string[];
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
  // True when current PR metadata and requested reviewers could not be read.
  reviewerLookupFailed?: boolean;
}

// A verified merge approval outranks later workflow labels, but a triaged PR
// still waits for automated review. Drafts take precedence. Labels are checked
// most-advanced first so a PR that briefly carries two of them (a bot
// mid-transition) reports the later stage.
// During a move back to in progress, this temporarily reports ready for review
// until the bot removes that label; the next live read reports in progress.
export function getPrStatusStage(state: PrStatusState): PrStatusStage {
  // PRs predating the workflow are excluded from every phase, including drafts
  // and approvals whose labels would otherwise imply a stage.
  if (
    PRE_REVIEW_START_DATE === null ||
    (state.pullRequest?.created_at !== undefined &&
      Date.parse(state.pullRequest.created_at) <
        Date.parse(PRE_REVIEW_START_DATE))
  ) {
    return "none";
  }
  const labels = new Set(state.labels);
  if (state.pullRequest?.draft) {
    return "draft";
  }
  // A triaged PR still needs automated review, even with merge approval. The
  // The triaged webhook adds in progress without waiting for maintainer input.
  if (hasPreReviewLabels(state.labels)) {
    return "triaged";
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

function formatReviewers(reviewers: string[]): string {
  return reviewers
    .filter((reviewer) => SAFE_REVIEWER_RE.test(reviewer))
    .map((reviewer) => `\`${reviewer}\``)
    .join(", ");
}

// Contributor-facing explanations of the workflow.
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
  const reReviewers = formatReviewers(state.reReviewers ?? []);
  switch (getPrStatusStage(state)) {
    case "draft":
      return (
        "## PR Status: draft\n\n" +
        "This PR is waiting for its author to mark it ready for review."
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
        (reReviewers
          ? `**Waiting for re-review:** ${reReviewers}.\n\n` +
            "These reviewers have been asked to review the latest updates."
          : state.hasChangesRequested
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
          : "") +
        "To become ready for review, the change must pass automated review " +
        "and every maintainer comment must be addressed, either with a code " +
        "change or a reply explaining why no change is needed. Any running " +
        "CI must finish and every failure must be classified as unrelated " +
        "to your PR (see status below in this comment).\n\n" +
        "To minimize iteration time, feel free to run the pr-review skill " +
        "from the repo locally. If an automated review comment is " +
        "irrelevant, react with 👎 on that specific comment to reject it, " +
        "and leave a short reply explaining why. To trigger a fresh " +
        "automated review, make a new push or comment `@pytorchbot review`. " +
        "To bypass automated review, please add the “no automated review” label."
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
        "comment `@pytorchbot triage` to run Auto PR Triage again."
      );
    case "triaged":
      return (
        "## PR Status: triaged\n\n" +
        (state.labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT)
          ? "This PR is queued for maintainer review without automated review. " +
            'The bot will automatically advance it to "ready for review".'
          : "This PR is queued for automated review. The bot should add " +
            '"in progress" shortly. If it does not, a maintainer can remove and ' +
            're-add "triaged" to retry.')
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

/** Current outstanding users and teams, without inferring requests from reviews. */
export function buildAssignedReviewers(
  owner: string,
  requestedReviewers: { login?: string }[],
  requestedTeams: { slug?: string }[]
): string[] {
  const users = requestedReviewers
    .map((user) => user?.login)
    .filter((login): login is string => Boolean(login));
  const teams = requestedTeams
    .map((team) => team?.slug)
    .filter((slug): slug is string => Boolean(slug))
    .map((slug) => `${owner}/${slug}`);
  return Array.from(new Set([...users, ...teams]));
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
 * Fetches approval, current PR metadata, and outstanding reviewer requests.
 * Draft status cannot be inferred from labels. Returns null when reviews are
 * unavailable so callers preserve current status; failed PR metadata leaves
 * current reviewer requests unknown.
 */
export async function fetchPrStatusState(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[],
  // Excludes the author from outstanding change requests if PR metadata fails.
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

  // Keep a supplied author for filtering outstanding change requests.
  const author = authorLogin ?? pull?.data.user?.login;

  const requestedReviewers = pull
    ? buildAssignedReviewers(
        owner,
        pull.data.requested_reviewers ?? [],
        pull.data.requested_teams ?? []
      )
    : undefined;
  const outstandingChanges = new Set(
    getOutstandingChangesReviewers(reviews, author ?? "").map((login) =>
      login.toLowerCase()
    )
  );

  return {
    labels: liveLabels,
    authorLogin: author,
    requestedReviewers,
    reReviewers: requestedReviewers?.filter((login) =>
      outstandingChanges.has(login.toLowerCase())
    ),
    pullRequest: pull
      ? {
          state: pull.data.state,
          draft: pull.data.draft,
          created_at: pull.data.created_at,
          headRef: pull.data.head?.ref,
        }
      : undefined,
    isApproved: approvalStatus === PR_APPROVED,
    isMergeApproved,
    mergeApprovalLookupFailed,
    hasChangesRequested: approvalStatus === PR_CHANGES_REQUESTED,
    reviewerLookupFailed: pullResult.status === "rejected",
  };
}
