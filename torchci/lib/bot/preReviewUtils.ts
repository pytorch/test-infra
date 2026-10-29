import {
  fetchPrStatusState,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_TRIAGED,
  PRE_REVIEW_START_DATE,
  PrStatusState,
} from "lib/prStatus";
import { Octokit } from "octokit";
import pLimit from "p-limit";
import shlex from "shlex";
import { getInputArgs, getParser } from "./cliParser";

// Bound checks of young PRs, rotating them so comment/reaction retries are not
// starved. Potential timeouts are uncapped; only known objections or qualifying
// merge approvals can defer a check.
const MAX_PRS_PER_RUN = 100;
const RUN_INTERVAL_MS = 15 * 60 * 1000;
const PRE_REVIEW_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const BLOCKED_RECHECK_MS = 6 * 60 * 60 * 1000;

type TimelineEvent = {
  event?: string;
  body?: string | null;
  actor?: { login?: string } | null;
  user?: { login?: string } | null;
  created_at?: string;
  submitted_at?: string;
  label?: { name?: string };
  state?: string;
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
  // Silent reviewers whose shared one-week pre-review deadline has passed.
  timedOut: string[];
  // Explicit objections remain pending, even after the deadline.
  rejected: string[];
  // Only a verified merge-rules approval skips pre-review. Other approvals
  // (or a failed merge-rules lookup) must not strand the PR here.
  isMergeApproved: boolean;
  lookupFailed: boolean;
  // Everyone whose agreement counted, including members agreeing for a team
  countedFrom: string[];
  // No assignments still waits for the deadline, rather than waiting forever.
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

// Whether the pre-review accept command applies to a PR, matching the PRs the
// scheduled run searches for
export function isInPreReview(pr: {
  state?: string;
  draft?: boolean;
  created_at?: string;
}): boolean {
  const startDate = PRE_REVIEW_START_DATE;
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

export function getPreReviewBatch<T extends { created_at: string }>(
  items: T[],
  now: number
): T[] {
  const young = items.filter(
    (pr) => Date.parse(pr.created_at) > now - PRE_REVIEW_WAIT_MS
  );
  const old = items.filter(
    (pr) => Date.parse(pr.created_at) <= now - PRE_REVIEW_WAIT_MS
  );
  return [
    ...old,
    ...getRotatingBatch(
      young,
      Math.floor(now / RUN_INTERVAL_MS),
      MAX_PRS_PER_RUN
    ),
  ];
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

// Start a fresh period when the PR enters pre-review, including a return from
// draft or a missing-actionable-issue hold. Review requests, comments, commits,
// and reactions never extend it. A known triage event is still required.
export function hasPreReviewTimedOut(
  events: TimelineEvent[],
  now: number = Date.now()
): boolean {
  if (
    !events.some(
      (event) =>
        event.event === "labeled" &&
        event.label?.name === PR_STATUS_LABEL_TRIAGED
    )
  ) {
    return false;
  }
  const enteredAt = events
    .filter(
      (event) =>
        (event.event === "labeled" &&
          event.label?.name === PR_STATUS_LABEL_TRIAGED) ||
        event.event === "ready_for_review" ||
        (event.event === "unlabeled" &&
          event.label?.name === PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE)
    )
    .map((event) => Date.parse(event.created_at ?? ""));
  // Missing/invalid history must not cause an early automatic acceptance.
  return (
    enteredAt.length > 0 && now >= Math.max(...enteredAt) + PRE_REVIEW_WAIT_MS
  );
}

// A thumbs-down on the description or an outstanding request for changes is
// an explicit response, never silence. A comment-only review doesn't clear a
// change request; an approval or dismissal does.
export function getPreReviewRejectors(
  events: TimelineEvent[],
  reactions: Reaction[]
): Set<string> {
  const changesRequested = new Set<string>();
  for (const event of events
    .filter((event) => event.event === "reviewed")
    .sort(
      (a, b) =>
        Date.parse(a.submitted_at ?? a.created_at ?? "") -
        Date.parse(b.submitted_at ?? b.created_at ?? "")
    )) {
    const login = event.user?.login ?? event.actor?.login;
    if (!login) {
      continue;
    }
    switch (event.state?.toLowerCase()) {
      case "changes_requested":
        changesRequested.add(login);
        break;
      case "approved":
      case "dismissed":
        changesRequested.delete(login);
        break;
    }
  }
  return new Set([
    ...changesRequested,
    ...reactions
      .filter((reaction) => reaction.content === "-1")
      .flatMap((reaction) =>
        reaction.user?.login ? [reaction.user.login] : []
      ),
  ]);
}

// A failed lookup stays pending, even after the deadline: otherwise we could
// miss a team member's explicit objection and mistake it for silence.
async function getTeamMembers(
  octokit: Octokit,
  team: string
): Promise<string[] | null> {
  const [org, teamSlug] = team.split("/");
  try {
    return (
      await octokit.paginate(octokit.rest.teams.listMembersInOrg, {
        org,
        team_slug: teamSlug,
        per_page: 100,
      })
    ).map((member) => member.login);
  } catch (error) {
    console.warn(`Failed to list members of team ${team}`, error);
    return null;
  }
}

/**
 * Check which assigned reviewers have agreed, by reacting with a thumbs-up to
 * the PR description or commenting `@pytorchbot pre-review accept`. A team
 * agrees once any member other than the author does, unless a member objects.
 * Silent reviewers (including teams) accept after one week in pre-review.
 *
 * acceptedBy covers a triggering comment that isn't in the timeline yet.
 * prState skips refetching the PR status when the caller already has it.
 */
export async function getPreReviewStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[],
  authorLogin: string,
  acceptedBy: string[] = [],
  prState?: PrStatusState,
  now: number = Date.now()
): Promise<PreReviewStatus> {
  const [state, events, reactions] = await Promise.all([
    prState ??
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
  const rejectedBy = getPreReviewRejectors(
    events as TimelineEvent[],
    reactions
  );
  rejectedBy.delete(authorLogin);
  const timedOut = hasPreReviewTimedOut(events as TimelineEvent[], now);
  const isMergeApproved =
    state?.isApproved === true && state.isMergeApproved === true;

  const agreed: string[] = [];
  const pending: string[] = [];
  const timedOutReviewers: string[] = [];
  const rejected: string[] = [];
  const countedFrom = new Set<string>();
  let lookupFailed = state === null || state.reviewerLookupFailed === true;
  for (const reviewer of assigned) {
    const members = reviewer.includes("/")
      ? await getTeamMembers(octokit, reviewer)
      : [reviewer];
    if (members === null) {
      lookupFailed = true;
      pending.push(reviewer);
      continue;
    }
    if (members.some((login) => rejectedBy.has(login))) {
      rejected.push(reviewer);
      pending.push(reviewer);
      continue;
    }
    const agreeing = members.filter((login) => agreedBy.has(login));
    agreeing.forEach((login) => countedFrom.add(login));
    if (agreeing.length > 0) {
      agreed.push(reviewer);
    } else if (timedOut) {
      timedOutReviewers.push(reviewer);
    } else {
      pending.push(reviewer);
    }
  }
  return {
    assigned,
    agreed,
    pending,
    timedOut: timedOutReviewers,
    rejected,
    isMergeApproved,
    lookupFailed,
    countedFrom: [...countedFrom].sort(),
    accepted:
      state !== null &&
      !state.reviewerLookupFailed &&
      hasPreReviewLabels(state.labels) &&
      !isMergeApproved &&
      (assigned.length > 0 || timedOut) &&
      pending.length === 0,
  };
}

export function hasPreReviewLabels(labels: string[]): boolean {
  return (
    labels.includes(PR_STATUS_LABEL_TRIAGED) &&
    !labels.includes(PR_STATUS_LABEL_IN_PROGRESS) &&
    !labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    !labels.includes(PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE)
  );
}

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
  const status = await getPreReviewStatus(
    octokit,
    owner,
    repo,
    prNumber,
    labels,
    authorLogin,
    acceptedBy
  );
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
