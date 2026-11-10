import { isPyTorchPyTorch } from "lib/bot/utils";
import {
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_START_DATE,
} from "lib/prStatus";
import { getRotatingBatch } from "lib/rotatingBatch";
import { Octokit } from "octokit";
import pLimit from "p-limit";
import { markTriagedInProgress } from "./triagedPromotion";

const MAX_PRS_PER_RUN = 100;
const RUN_INTERVAL_MS = 15 * 60 * 1000;

type SearchItems = Awaited<
  ReturnType<Octokit["rest"]["search"]["issuesAndPullRequests"]>
>["data"]["items"];

// GitHub search only exposes the first 1,000 results. Split busy creation-date
// ranges so PRs beyond that limit cannot be permanently missed by the sweep.
async function searchTriagedPrs(
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
      throw new Error("Too many triaged PRs created in the same second");
    }
    const middle = Math.floor((since + until) / 2);
    return [
      ...(await searchTriagedPrs(octokit, query, since, middle)),
      ...(await searchTriagedPrs(octokit, query, middle + 1, until)),
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

export interface TriageSweepResult {
  checked: number;
  failed: number[];
}

// A bounded fallback for missed label events. All candidates, regardless of
// age or approval, rotate through the same 100-PR batch every 15 minutes.
export async function updateInProgressLabels(
  reader: Octokit,
  labeler: Octokit,
  owner: string,
  repo: string
): Promise<TriageSweepResult> {
  const result: TriageSweepResult = { checked: 0, failed: [] };
  const startDate = PR_STATUS_START_DATE;
  if (!isPyTorchPyTorch(owner, repo) || startDate === null) return result;
  const now = Date.now();
  const candidates = await searchTriagedPrs(
    reader,
    // Approved PRs still need automated review. Do not filter by reviews.
    `repo:${owner}/${repo} is:pr is:open draft:false label:"${PR_STATUS_LABEL_TRIAGED}" -label:"${PR_STATUS_LABEL_IN_PROGRESS}" -label:"${PR_STATUS_LABEL_READY_FOR_REVIEW}" -label:"${PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE}"`,
    Math.floor(Date.parse(startDate) / 1000),
    Math.floor(now / 1000)
  );
  // Stable ordering and deduplication keep overlapping search pages from
  // consuming batch slots or re-triggering the same promotion.
  const uniqueCandidates = [
    ...new Map(candidates.map((pr) => [pr.number, pr])).values(),
  ].sort((a, b) => a.number - b.number);
  const limit = pLimit(5);
  await Promise.all(
    getRotatingBatch(
      uniqueCandidates,
      Math.floor(now / RUN_INTERVAL_MS),
      MAX_PRS_PER_RUN
    ).map((pr) =>
      limit(async () => {
        try {
          result.checked++;
          await markTriagedInProgress(reader, labeler, owner, repo, pr.number);
        } catch (error) {
          result.failed.push(pr.number);
          console.error(
            `Failed to promote triaged PR ${owner}/${repo}#${pr.number}`,
            error
          );
        }
      })
    )
  );
  result.failed.sort((a, b) => a - b);
  return result;
}
