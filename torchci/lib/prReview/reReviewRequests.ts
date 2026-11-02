import { hasTriageOrHigherPermissions } from "lib/bot/utils";
import { PR_STATUS_LABEL_IN_PROGRESS } from "lib/prStatus";
import {
  getOutstandingChangesReviewers,
  ReReviewReview,
} from "lib/reviewApproval";
import { Octokit } from "octokit";

interface ReviewRequestEvent {
  id?: number;
  event?: string;
  created_at?: string;
  label?: { name?: string };
  requested_reviewer?: { login?: string };
}

function compareEvents(a: ReviewRequestEvent, b: ReviewRequestEvent): number {
  return (
    Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "") ||
    (a.id ?? 0) - (b.id ?? 0)
  );
}

/**
 * Re-request outstanding human changes reviewers for an in-progress -> ready
 * transition. Call BEFORE writing readiness labels, after all readiness gates
 * pass. A failed request then leaves the transition eligible for a retry.
 *
 * Live requests cover a successful write whose response was lost. Timeline
 * events cover requests subsequently answered or explicitly removed: neither
 * should notify the same reviewer again on a retry of this transition. A new
 * in-progress label starts a fresh transition. Errors propagate to the caller.
 */
export async function requestOutstandingChangesReviewers(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  author: string,
  reviews?: ReReviewReview[]
): Promise<string[]> {
  const candidates = getOutstandingChangesReviewers(
    reviews ??
      (await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      })),
    author
  );
  if (candidates.length === 0) {
    return [];
  }

  const [events, requested] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.rest.pulls.listRequestedReviewers({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);
  const handled = new Set(
    requested.data.users.map((user) => user.login.toLowerCase())
  );
  const timeline = events as ReviewRequestEvent[];
  const transition = timeline
    .filter(
      (event) =>
        event.event === "labeled" &&
        event.label?.name === PR_STATUS_LABEL_IN_PROGRESS
    )
    .sort(compareEvents)
    .at(-1);
  // Without a known boundary we cannot safely distinguish a retry from a new
  // transition. Keep the promotion retryable instead of risking another ping.
  if (
    !transition ||
    !Number.isFinite(Date.parse(transition.created_at ?? ""))
  ) {
    throw new Error(
      `Cannot identify the in-progress transition for ${owner}/${repo}#${prNumber}`
    );
  }
  for (const event of timeline) {
    const login = event.requested_reviewer?.login;
    if (
      login &&
      (event.event === "review_requested" ||
        event.event === "review_request_removed") &&
      compareEvents(event, transition) >= 0
    ) {
      handled.add(login.toLowerCase());
    }
  }

  const reviewers: string[] = [];
  for (const login of candidates) {
    if (
      !handled.has(login.toLowerCase()) &&
      (await hasTriageOrHigherPermissions(octokit, owner, repo, login))
    ) {
      reviewers.push(login);
    }
  }
  if (reviewers.length > 0) {
    await octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: prNumber,
      reviewers,
    });
  }
  return reviewers;
}
