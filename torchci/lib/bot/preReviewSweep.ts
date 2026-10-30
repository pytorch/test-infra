// Scheduled and webhook-driven advancement and status updates. Policy reads
// live in preReviewUtils so rendering can share them without invoking writes.
import { upsertPrStatusSection } from "lib/drciUtils";
import {
  fetchPrStatusState,
  hasPreReviewLabels,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_TRIAGED,
  PRE_REVIEW_START_DATE,
} from "lib/prStatus";
import { Octokit } from "octokit";
import pLimit from "p-limit";
import {
  getPreReviewBatch,
  getPreReviewStatus,
  isInPreReview,
  PreReviewStatus,
} from "./preReviewUtils";

const BLOCKED_RECHECK_MS = 6 * 60 * 60 * 1000;

// Mark a triaged PR in progress once every reviewer agrees or times out. The
// triaged label is kept, so a PR already past automated review (ready for
// review) is skipped, or adding in progress again would trigger another review.
// Read through the pre-review app, but label as PyTorchBot: the automated
// review workflow requires that identity to trigger a review.
export async function markInProgressIfAccepted(
  octokit: Octokit,
  labelOctokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[],
  authorLogin: string,
  acceptedBy: string[] = []
): Promise<PreReviewStatus> {
  const state = await fetchPrStatusState(
    octokit,
    owner,
    repo,
    prNumber,
    labels,
    authorLogin
  );
  const status = await getPreReviewStatus(
    octokit,
    owner,
    repo,
    prNumber,
    labels,
    authorLogin,
    acceptedBy,
    state
  );
  labels = state?.labels ?? labels;
  if (status.accepted && hasPreReviewLabels(labels)) {
    // Search results and webhook payloads can be stale. In particular, an old
    // PR may have closed, become a draft, or advanced since the sweep found it.
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    if (
      !isInPreReview(pr) ||
      !hasPreReviewLabels(pr.labels.map((label) => label.name))
    ) {
      return status;
    }
    console.log(
      `Adding "${PR_STATUS_LABEL_IN_PROGRESS}" to ${owner}/${repo}#${prNumber}, accepted by ${status.agreed.join(
        ", "
      )}; timed out: ${status.timedOut.join(", ")}`
    );
    await labelOctokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [PR_STATUS_LABEL_IN_PROGRESS],
    });
    labels = [
      ...pr.labels.map((label) => label.name),
      PR_STATUS_LABEL_IN_PROGRESS,
    ];
  }
  if (state && !status.lookupFailed) {
    await upsertPrStatusSection(
      labelOctokit,
      owner,
      repo,
      prNumber,
      labels,
      authorLogin,
      { reader: octokit, state: { ...state, labels, preReview: status } }
    );
  }
  return status;
}

type SearchItems = Awaited<
  ReturnType<Octokit["rest"]["search"]["issuesAndPullRequests"]>
>["data"]["items"];

// GitHub search only exposes the first 1,000 results. Split busy creation-date
// ranges so PRs beyond that limit cannot be permanently missed by the sweep.
async function searchPreReviewPrs(
  octokit: Octokit,
  query: string,
  since: number,
  until: number
): Promise<SearchItems> {
  const params = {
    q: `${query} created:${new Date(since * 1000).toISOString()}..${new Date(
      until * 1000
    ).toISOString()}`,
    sort: "created" as const,
    order: "asc" as const,
    per_page: 100,
  };
  const { data } = await octokit.rest.search.issuesAndPullRequests(params);
  if (data.total_count > 1000) {
    if (since >= until) {
      throw new Error("Too many pre-review PRs created in the same second");
    }
    const middle = Math.floor((since + until) / 2);
    return [
      ...(await searchPreReviewPrs(octokit, query, since, middle)),
      ...(await searchPreReviewPrs(octokit, query, middle + 1, until)),
    ];
  }
  const items = [...data.items];
  for (let page = 2; page <= Math.ceil(data.total_count / 100); page++) {
    const response = await octokit.rest.search.issuesAndPullRequests({
      ...params,
      page,
    });
    items.push(...response.data.items);
  }
  return items;
}

export interface PreReviewRecheck {
  updatedAt: string;
  nextCheckAt: number;
}

export type PreReviewRechecks = Record<string, PreReviewRecheck>;

export interface PreReviewSweepResult {
  rechecks: PreReviewRechecks;
  checked: number;
  deferred: number;
  failed: number[];
}

// Reactions and the one-week deadline do not trigger webhooks. An independent
// 15-minute cron also checks PRs with no reactions or recent CI activity.
// A PR must be at least a week old to have spent a week in pre-review, so all
// potential timeouts are checked each run, independently of the young-PR batch.
export async function updateInProgressLabels(
  octokit: Octokit,
  labelOctokit: Octokit,
  owner: string,
  repo: string,
  previousRechecks: PreReviewRechecks = {}
): Promise<PreReviewSweepResult> {
  const result: PreReviewSweepResult = {
    rechecks: {},
    checked: 0,
    deferred: 0,
    failed: [],
  };
  const startDate = PRE_REVIEW_START_DATE;
  if (startDate === null) {
    return result;
  }
  const now = Date.now();
  const candidates = (
    await searchPreReviewPrs(
      octokit,
      // Do not use -review:approved: GitHub doesn't know which approvals
      // satisfy merge_rules.yaml, so that would hide legitimate candidates.
      `repo:${owner}/${repo} is:pr is:open draft:false label:"${PR_STATUS_LABEL_TRIAGED}" -label:"${PR_STATUS_LABEL_IN_PROGRESS}" -label:"${PR_STATUS_LABEL_READY_FOR_REVIEW}" -label:"${PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE}"`,
      Math.floor(Date.parse(startDate) / 1000),
      Math.floor(now / 1000)
    )
  ).filter((pr) => pr.user?.login);

  const due = candidates.filter((pr) => {
    const previous = previousRechecks[pr.number];
    if (
      previous &&
      previous.updatedAt === pr.updated_at &&
      previous.nextCheckAt > now
    ) {
      result.rechecks[pr.number] = previous;
      result.deferred++;
      return false;
    }
    return true;
  });

  // Limit concurrent GitHub requests without delaying expired PRs to another
  // run. One failed PR must not prevent the remaining deadline checks.
  const limit = pLimit(5);
  await Promise.all(
    getPreReviewBatch(due, now).map((pr) =>
      limit(async () => {
        try {
          result.checked++;
          const status = await markInProgressIfAccepted(
            octokit,
            labelOctokit,
            owner,
            repo,
            pr.number,
            pr.labels.map((label) =>
              typeof label === "string" ? label : label.name ?? ""
            ),
            pr.user!.login
          );
          if (status.lookupFailed) {
            result.failed.push(pr.number);
            return;
          }
          // Only explicit objections and verified merge approvals are deferred.
          // Silence remains on the normal deadline path. Updated PRs invalidate
          // this entry; the bounded retry also detects reaction removal (which
          // emits no webhook and need not update the PR's updated_at).
          if (status.isMergeApproved || status.rejected.length > 0) {
            result.rechecks[pr.number] = {
              updatedAt: pr.updated_at,
              nextCheckAt: now + BLOCKED_RECHECK_MS,
            };
          }
        } catch (error) {
          result.failed.push(pr.number);
          console.error(
            `Failed to update pre-review status for ${owner}/${repo}#${pr.number}`,
            error
          );
        }
      })
    )
  );
  result.failed.sort((a, b) => a - b);
  return result;
}
