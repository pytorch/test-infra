import {
  fetchPrStatusState,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_LABELS,
  PRE_REVIEW_START_DATE,
} from "lib/prStatus";
import { Octokit } from "octokit";
import shlex from "shlex";
import { getInputArgs, getParser } from "./cliParser";

// Bounds the GitHub API calls of each scheduled run, which checks a different
// batch each time so no PR is starved
const MAX_PRS_PER_RUN = 100;
const RUN_INTERVAL_MS = 15 * 60 * 1000;

type TimelineEvent = {
  event?: string;
  body?: string | null;
  actor?: { login?: string } | null;
  user?: { login?: string } | null;
};

type Reaction = {
  content?: string;
  user?: { login?: string } | null;
};

export interface PreReviewStatus {
  // Teams are listed as "org/team", as in the PR Status section
  assigned: string[];
  agreed: string[];
  pending: string[];
  // Everyone whose agreement counted, including members agreeing for a team
  countedFrom: string[];
  // A PR with no assigned reviewers is never accepted
  accepted: boolean;
}

// Parse the same way the bot does, so help requests and invalid arguments
// don't count
function isPreReviewAcceptCommand(body: string | null | undefined) {
  try {
    const splitArgs = shlex.split(getInputArgs(body ?? ""));
    const args = getParser().parse_args(splitArgs);
    return (
      args.command === "pre-review" &&
      !args.help &&
      !splitArgs.includes("-h") &&
      !splitArgs.includes("--help")
    );
  } catch {
    return false;
  }
}

// Returns null until pre-review is rolled out
function getPreReviewStartDate(): string | null {
  return PR_STATUS_LABELS.includes(PR_STATUS_LABEL_TRIAGED)
    ? PRE_REVIEW_START_DATE
    : null;
}

// Whether the pre-review accept command applies to a PR, matching the PRs the
// scheduled run searches for
export function isInPreReview(pr: {
  state?: string;
  draft?: boolean;
  created_at?: string;
}): boolean {
  const startDate = getPreReviewStartDate();
  return (
    startDate !== null &&
    pr.state === "open" &&
    !pr.draft &&
    pr.created_at !== undefined &&
    new Date(pr.created_at) >= new Date(startDate)
  );
}

export function getRotatingBatch<T>(
  items: T[],
  run: number,
  size: number
): T[] {
  if (items.length <= size) {
    return items;
  }
  const offset = (run * size) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)].slice(0, size);
}

// Everyone who commented or reviewed with `@pytorchbot pre-review accept`
export function getPreReviewAcceptors(events: TimelineEvent[]): Set<string> {
  const acceptors = new Set<string>();
  for (const event of events) {
    if (event.event !== "commented" && event.event !== "reviewed") {
      continue;
    }
    const login = event.user?.login ?? event.actor?.login;
    if (login && isPreReviewAcceptCommand(event.body)) {
      acceptors.add(login);
    }
  }
  return acceptors;
}

export function getThumbsUpReactors(reactions: Reaction[]): Set<string> {
  const reactors = new Set<string>();
  for (const reaction of reactions) {
    if (reaction.content === "+1" && reaction.user?.login) {
      reactors.add(reaction.user.login);
    }
  }
  return reactors;
}

// A failed lookup returns no one, so the team stays pending
async function getAgreeingTeamMembers(
  octokit: Octokit,
  team: string,
  agreedBy: Set<string>
): Promise<string[]> {
  const [org, teamSlug] = team.split("/");
  try {
    return (
      await octokit.paginate(octokit.rest.teams.listMembersInOrg, {
        org,
        team_slug: teamSlug,
        per_page: 100,
      })
    )
      .map((member) => member.login)
      .filter((login) => agreedBy.has(login));
  } catch (error) {
    console.warn(`Failed to list members of team ${team}`, error);
    return [];
  }
}

/**
 * Check which assigned reviewers have agreed, by reacting with a thumbs-up to
 * the PR description or commenting `@pytorchbot pre-review accept`. A team
 * agrees once any member other than the author does.
 *
 * acceptedBy covers a triggering comment that isn't in the timeline yet.
 */
export async function getPreReviewStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[],
  authorLogin: string,
  acceptedBy: string[] = []
): Promise<PreReviewStatus> {
  const [state, events, reactions] = await Promise.all([
    fetchPrStatusState(octokit, owner, repo, prNumber, labels, authorLogin),
    octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.reactions.listForIssue, {
      owner,
      repo,
      issue_number: prNumber,
      content: "+1",
      per_page: 100,
    }),
  ]);

  // A failed PR lookup drops requested reviewers who haven't reviewed yet, so
  // treat it like having no reviewers rather than risk labeling early
  const assigned =
    !state || state.reviewerLookupFailed
      ? []
      : [...state.assignedReviewers].sort();
  const agreedBy = new Set([
    ...getThumbsUpReactors(reactions as Reaction[]),
    ...getPreReviewAcceptors(events as TimelineEvent[]),
    ...acceptedBy,
  ]);
  agreedBy.delete(authorLogin);

  const agreed: string[] = [];
  const pending: string[] = [];
  const countedFrom = new Set<string>();
  for (const reviewer of assigned) {
    const agreeing = reviewer.includes("/")
      ? await getAgreeingTeamMembers(octokit, reviewer, agreedBy)
      : agreedBy.has(reviewer)
      ? [reviewer]
      : [];
    agreeing.forEach((login) => countedFrom.add(login));
    (agreeing.length > 0 ? agreed : pending).push(reviewer);
  }
  return {
    assigned,
    agreed,
    pending,
    countedFrom: [...countedFrom].sort(),
    accepted: assigned.length > 0 && pending.length === 0,
  };
}

// Move a triaged PR to in progress once every assigned reviewer agrees. The
// label is added before triaged is removed so the PR always has a status.
export async function markInProgressIfAccepted(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[],
  authorLogin: string,
  acceptedBy: string[] = []
): Promise<PreReviewStatus> {
  const status = await getPreReviewStatus(
    octokit,
    owner,
    repo,
    prNumber,
    labels,
    authorLogin,
    acceptedBy
  );
  if (
    status.accepted &&
    labels.includes(PR_STATUS_LABEL_TRIAGED) &&
    !labels.includes(PR_STATUS_LABEL_IN_PROGRESS)
  ) {
    console.log(
      `Adding "${PR_STATUS_LABEL_IN_PROGRESS}" to ${owner}/${repo}#${prNumber}, accepted by ${status.agreed.join(
        ", "
      )}`
    );
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [PR_STATUS_LABEL_IN_PROGRESS],
    });
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: prNumber,
      name: PR_STATUS_LABEL_TRIAGED,
    });
  }
  return status;
}

// Check open PRs in pre-review that have a thumbs-up on the description. The
// accept command adds one, so PRs agreed to by comment are checked too.
export async function updateInProgressLabels(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<void> {
  const startDate = getPreReviewStartDate();
  if (startDate === null) {
    return;
  }
  const candidates = (
    await octokit.paginate(octokit.rest.search.issuesAndPullRequests, {
      q: `repo:${owner}/${repo} is:pr is:open draft:false label:"${PR_STATUS_LABEL_TRIAGED}" -label:"${PR_STATUS_LABEL_IN_PROGRESS}" created:>=${startDate} reactions:>0`,
      sort: "created",
      order: "asc",
      per_page: 100,
    })
  ).filter((pr) => pr.user?.login && (pr.reactions?.["+1"] ?? 0) > 0);
  if (candidates.length > MAX_PRS_PER_RUN) {
    console.warn(
      `${candidates.length} PRs in pre-review have a thumbs-up, checking ${MAX_PRS_PER_RUN} this run`
    );
  }

  for (const pr of getRotatingBatch(
    candidates,
    Math.floor(Date.now() / RUN_INTERVAL_MS),
    MAX_PRS_PER_RUN
  )) {
    try {
      await markInProgressIfAccepted(
        octokit,
        owner,
        repo,
        pr.number,
        pr.labels.map((label) =>
          typeof label === "string" ? label : label.name ?? ""
        ),
        pr.user!.login
      );
    } catch (error) {
      console.error(
        `Failed to update pre-review status for ${owner}/${repo}#${pr.number}`,
        error
      );
    }
  }
}
