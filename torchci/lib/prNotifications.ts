import { getPreReviewStatus } from "lib/bot/preReviewUtils";
import {
  fetchPrStatusState,
  getPrStatusStage,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_TRIAGED,
  PRE_REVIEW_START_DATE,
} from "lib/prStatus";
import { Octokit } from "octokit";
import pLimit from "p-limit";

// The daily list of PRs waiting on each reviewer, read by Meta's internal
// notification job, which DMs each reviewer a digest. It holds only public
// GitHub data.

export type ReviewStage = "pre_review" | "final_review";

export interface ManifestPr {
  title: string;
  url: string;
  author: string;
  stage: ReviewStage;
  // When the PR got the label for its current stage, null if not found
  stage_since: string | null;
}

export interface ReviewerEntry {
  pr: number;
  // The team ("org/team") the reviewer was asked through, when it was a team
  via?: string;
}

export interface PrNotificationsManifest {
  generated_at: string;
  prs: Record<number, ManifestPr>;
  reviewers: Record<string, Record<ReviewStage, ReviewerEntry[]>>;
  // PRs that could not be checked, so their reviewers are missing above
  failed_prs: number[];
}

type SearchItem = {
  number: number;
  title: string;
  html_url: string;
  user?: { login?: string } | null;
  labels: (string | { name?: string })[];
};

type WaitingPr = {
  pr: ManifestPr;
  reviewers: { login: string; via?: string }[];
};

const CONCURRENCY = 10;

// The PR is waiting on its author to link an actionable issue, not on reviewers
const MISSING_ACTIONABLE_ISSUE_LABEL = "missing actionable issue";

// review-logs/ is the bucket's publicly readable prefix, which the internal job
// reads through fwdproxy
export function getManifestKey(generatedAt: Date): string {
  const date = generatedAt.toISOString().slice(0, 10);
  return `review-logs/pr-notifications/manifest-${date}.json`;
}

async function searchOpenPrs(
  octokit: Octokit,
  owner: string,
  repo: string,
  qualifier: string
): Promise<SearchItem[]> {
  return (await octokit.paginate(octokit.rest.search.issuesAndPullRequests, {
    q: `repo:${owner}/${repo} is:pr is:open draft:false ${qualifier}`,
    per_page: 100,
  })) as SearchItem[];
}

async function getStageSince(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  label: string
): Promise<string | null> {
  const events = await octokit.paginate(octokit.rest.issues.listEvents, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const labeled = events.filter(
    (event: any) => event.event === "labeled" && event.label?.name === label
  );
  return labeled[labeled.length - 1]?.created_at ?? null;
}

/**
 * Lists who each open PR is waiting on: pending assigned reviewers in
 * pre-review, as decided by getPreReviewStatus, and requested reviewers in
 * final review. Teams are expanded so every member except the author gets the
 * PR.
 */
export async function buildPrNotificationsManifest(
  octokit: Octokit,
  owner: string,
  repo: string,
  now: Date = new Date()
): Promise<PrNotificationsManifest> {
  const candidates = await searchOpenPrs(
    octokit,
    owner,
    repo,
    `label:"${PR_STATUS_LABEL_READY_FOR_REVIEW}"`
  );
  if (PRE_REVIEW_START_DATE !== null) {
    candidates.push(
      ...(await searchOpenPrs(
        octokit,
        owner,
        repo,
        `label:"${PR_STATUS_LABEL_TRIAGED}" created:>=${PRE_REVIEW_START_DATE}`
      ))
    );
  }
  const prs = [...new Map(candidates.map((pr) => [pr.number, pr])).values()];

  const teamMembers = new Map<string, Promise<string[]>>();
  function getTeamMembers(team: string): Promise<string[]> {
    if (!teamMembers.has(team)) {
      const [org, teamSlug] = team.split("/");
      const members = octokit
        .paginate(octokit.rest.teams.listMembersInOrg, {
          org,
          team_slug: teamSlug,
          per_page: 100,
        })
        .then((list) => list.map((member) => member.login));
      // Let the next PR retry rather than reuse a transient failure
      members.catch(() => teamMembers.delete(team));
      teamMembers.set(team, members);
    }
    return teamMembers.get(team)!;
  }

  async function getWaitingPr(pr: SearchItem): Promise<WaitingPr | null> {
    const author = pr.user?.login;
    if (!author) {
      return null;
    }
    const labels = pr.labels.map((label) =>
      typeof label === "string" ? label : label.name ?? ""
    );
    if (labels.includes(MISSING_ACTIONABLE_ISSUE_LABEL)) {
      return null;
    }
    const state = await fetchPrStatusState(
      octokit,
      owner,
      repo,
      pr.number,
      labels,
      author
    );
    if (state === null) {
      throw new Error("review lookup failed");
    }

    let stage: ReviewStage;
    let stageLabel: string;
    let pending: string[];
    // Approved PRs are skipped, and a PR carrying two status labels mid-move
    // counts as the later stage, as in the PR Status section
    switch (getPrStatusStage(state)) {
      case "preReview":
        // getPreReviewStatus reads a failed lookup as no reviewers, which
        // would drop the PR without recording it as failed
        if (state.reviewerLookupFailed) {
          throw new Error("reviewer lookup failed");
        }
        stage = "pre_review";
        stageLabel = PR_STATUS_LABEL_TRIAGED;
        pending = (
          await getPreReviewStatus(
            octokit,
            owner,
            repo,
            pr.number,
            labels,
            author,
            [],
            state
          )
        ).pending;
        break;
      case "readyForReview": {
        stage = "final_review";
        stageLabel = PR_STATUS_LABEL_READY_FOR_REVIEW;
        const pull = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: pr.number,
        });
        pending = [
          ...(pull.data.requested_reviewers ?? []).map((user) => user.login),
          ...(pull.data.requested_teams ?? []).map(
            (team) => `${owner}/${team.slug}`
          ),
        ];
        break;
      }
      default:
        return null;
    }
    if (pending.length === 0) {
      return null;
    }

    const reviewers: WaitingPr["reviewers"] = [];
    for (const reviewer of pending) {
      if (!reviewer.includes("/")) {
        reviewers.push({ login: reviewer });
        continue;
      }
      for (const member of await getTeamMembers(reviewer)) {
        if (member !== author) {
          reviewers.push({ login: member, via: reviewer });
        }
      }
    }
    return {
      pr: {
        title: pr.title,
        url: pr.html_url,
        author,
        stage,
        stage_since: await getStageSince(
          octokit,
          owner,
          repo,
          pr.number,
          stageLabel
        ),
      },
      reviewers,
    };
  }

  const manifest: PrNotificationsManifest = {
    generated_at: now.toISOString(),
    prs: {},
    reviewers: {},
    failed_prs: [],
  };
  const limit = pLimit(CONCURRENCY);
  await Promise.all(
    prs.map((pr) =>
      limit(async () => {
        let waiting: WaitingPr | null;
        try {
          waiting = await getWaitingPr(pr);
        } catch (error) {
          console.error(
            `Failed to check reviewers for ${owner}/${repo}#${pr.number}`,
            error
          );
          manifest.failed_prs.push(pr.number);
          return;
        }
        if (waiting === null) {
          return;
        }
        manifest.prs[pr.number] = waiting.pr;
        for (const { login, via } of waiting.reviewers) {
          manifest.reviewers[login] ??= { pre_review: [], final_review: [] };
          const entries = manifest.reviewers[login][waiting.pr.stage];
          const existing = entries.find((entry) => entry.pr === pr.number);
          if (!existing) {
            entries.push(via ? { pr: pr.number, via } : { pr: pr.number });
          } else if (!via) {
            // Asked directly as well as through a team
            delete existing.via;
          }
        }
      })
    )
  );

  manifest.failed_prs.sort((a, b) => a - b);
  for (const stages of Object.values(manifest.reviewers)) {
    stages.pre_review.sort((a, b) => a.pr - b.pr);
    stages.final_review.sort((a, b) => a.pr - b.pr);
  }
  return manifest;
}
