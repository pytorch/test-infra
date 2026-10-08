// Moves a pytorch/pytorch PR from `in progress` to `ready for review` once the
// automated review passed on its current head, CI is green (isCiGoodForReview
// in drci.ts), and no maintainer commented after that review
// started. Run from the Dr.CI sweep, which revisits a PR on CI activity and
// while its review is live (getPRsNeedingCommentRefresh in drci.ts).

import { hasTriageOrHigherPermissions } from "lib/bot/utils";
import { queryClickhouseSaved } from "lib/clickhouse";
import { isBot } from "lib/greenlight/greenlightReviewGate";
import {
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_REVIEW_OPT_OUT,
} from "lib/prStatus";
import { Octokit } from "octokit";

// As the pr_review_head_verdicts_for_prs saved query returns it.
export interface PrReviewHeadVerdictRow {
  pr_number: number | string;
  head_sha: string;
  status: string;
  verdict: string | null;
  // Int64 columns come back as strings.
  started_at_ms: number | string;
}

// pr_number -> the newest finished review of the head Dr.CI evaluated.
export async function fetchPrReviewHeadVerdicts(
  owner: string,
  repo: string,
  headShaByPr: Map<number, string>
): Promise<Map<number, PrReviewHeadVerdictRow>> {
  const verdicts = new Map<number, PrReviewHeadVerdictRow>();
  if (headShaByPr.size === 0) {
    return verdicts;
  }
  const rows = (await queryClickhouseSaved("pr_review_head_verdicts_for_prs", {
    repo: `${owner}/${repo}`,
    prNumbers: Array.from(headShaByPr.keys()),
  })) as PrReviewHeadVerdictRow[];
  for (const row of rows) {
    const prNumber = Number(row.pr_number);
    if (headShaByPr.get(prNumber) === row.head_sha) {
      verdicts.set(prNumber, row);
    }
  }
  return verdicts;
}

export function isPassingReview(
  row: PrReviewHeadVerdictRow | undefined,
  headSha: string
): row is PrReviewHeadVerdictRow {
  return (
    row !== undefined &&
    row.head_sha === headSha &&
    row.status === "succeeded" &&
    row.verdict === "ready_for_human_review" &&
    Number.isFinite(Number(row.started_at_ms))
  );
}

export interface ReadyForReviewState {
  // Live from GitHub, not the ClickHouse mirror.
  labels: string[];
  prState: string;
  draft: boolean;
  liveHeadSha: string;
  // The head Dr.CI classified.
  evaluatedHeadSha: string;
  review: PrReviewHeadVerdictRow | undefined;
  ciGreen: boolean;
}

// Every condition but maintainer activity, which costs API calls and so is
// only checked for PRs that pass this.
export function shouldPromoteToReadyForReview(
  state: ReadyForReviewState
): boolean {
  return (
    state.labels.includes(PR_STATUS_LABEL_IN_PROGRESS) &&
    !state.labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    !state.labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT) &&
    state.prState === "open" &&
    !state.draft &&
    state.liveHeadSha === state.evaluatedHeadSha &&
    isPassingReview(state.review, state.evaluatedHeadSha) &&
    state.ciGreen
  );
}

export interface PrActivity {
  user?: { login?: string; type?: string } | null;
  at?: string | null;
}

// Humans other than the author with activity strictly after sinceMs.
export function activeUsersSince(
  activities: PrActivity[],
  sinceMs: number,
  author: string
): string[] {
  const logins = new Set<string>();
  for (const { user, at } of activities) {
    const login = user?.login;
    if (
      login &&
      login !== author &&
      !isBot(login, user?.type) &&
      at &&
      Date.parse(at) > sinceMs
    ) {
      logins.add(login);
    }
  }
  return Array.from(logins);
}

async function hasMaintainerActivitySince(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  author: string,
  sinceMs: number
): Promise<boolean> {
  // `since` filters on updated_at, a superset of what activeUsersSince keeps.
  const since = new Date(sinceMs).toISOString();
  const [comments, reviews, reviewComments] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      since,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      since,
      per_page: 100,
    }),
  ]);
  const activities: PrActivity[] = [
    ...comments.map((c) => ({ user: c.user, at: c.created_at })),
    // An approval with no text asks for nothing.
    ...reviews
      .filter((r) => r.state !== "APPROVED" || r.body)
      .map((r) => ({ user: r.user, at: r.submitted_at })),
    ...reviewComments.map((c) => ({ user: c.user, at: c.created_at })),
  ];
  for (const login of activeUsersSince(activities, sinceMs, author)) {
    if (await hasTriageOrHigherPermissions(octokit, owner, repo, login)) {
      return true;
    }
  }
  return false;
}

export type PromotionOutcome =
  | "promoted"
  | "maintainer_activity"
  | "not_eligible";

// Shown when maintainer activity is all that blocks the promotion: nothing else
// re-runs the review, so the PR would otherwise wait with no explanation.
export const STALE_REVIEW_NOTE =
  "Maintainers commented after the automated review started. Once you have " +
  "addressed their comments, comment `@pytorchbot review` to re-run the " +
  "automated review and move this PR forward.";

// After the collapsed review section, so the note stays visible.
export function withStaleReviewNote(
  prReviewSection: string,
  outcome: PromotionOutcome
): string {
  return outcome === "maintainer_activity"
    ? `${prReviewSection}\n\n${STALE_REVIEW_NOTE}`
    : prReviewSection;
}

// Any API error propagates, so the caller promotes nothing for that PR.
export async function maybePromoteToReadyForReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  evaluatedHeadSha: string,
  review: PrReviewHeadVerdictRow | undefined,
  ciGreen: boolean
): Promise<PromotionOutcome> {
  // Most PRs in a sweep stop here, before any API call.
  if (!ciGreen || !isPassingReview(review, evaluatedHeadSha)) {
    return "not_eligible";
  }
  const pr = (
    await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
  ).data;
  const author = pr.user?.login;
  if (
    !author ||
    !shouldPromoteToReadyForReview({
      labels: pr.labels.map((label) => label.name),
      prState: pr.state,
      draft: pr.draft ?? false,
      liveHeadSha: pr.head.sha,
      evaluatedHeadSha,
      review,
      ciGreen,
    })
  ) {
    return "not_eligible";
  }
  if (
    await hasMaintainerActivitySince(
      octokit,
      owner,
      repo,
      prNumber,
      author,
      Number(review.started_at_ms)
    )
  ) {
    return "maintainer_activity";
  }

  console.log(
    `Adding "${PR_STATUS_LABEL_READY_FOR_REVIEW}" to ${owner}/${repo}#${prNumber}: automated review passed on ${evaluatedHeadSha} and CI is green`
  );
  // Add before remove, so the PR always has a status label.
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: [PR_STATUS_LABEL_READY_FOR_REVIEW],
  });
  await octokit.rest.issues.removeLabel({
    owner,
    repo,
    issue_number: prNumber,
    name: PR_STATUS_LABEL_IN_PROGRESS,
  });
  return "promoted";
}
