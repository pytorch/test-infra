import {
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_TRIAGED,
} from "lib/prStatus";
import pLimit from "p-limit";
import { Context, Probot } from "probot";
import { PYTORCH_BOT_USER_ID } from "./Constants";
import { isPyTorchPyTorch } from "./utils";

const OPEN_SOURCE = "open source";
const TRIAGE_OUTCOMES = [
  PR_STATUS_LABEL_TRIAGED,
  "bot-triaged",
  "bot-triage-error",
];

type IssueContext = Context<"issues.labeled">;
type Reference = { number: number; repository: { nameWithOwner: string } };
type Page<T> = {
  nodes: (T | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

// Match Auto PR Triage's description claims, including its exclusion of code
// and HTML comments. Closing references are verified through GitHub instead.
function hasPartOfReference(body: string, repository: string, issue: number) {
  const rendered = body.replace(
    /<!--[\s\S]*?(?:-->|$)|(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g,
    " "
  );
  const pattern =
    /(?<![\w-])part\s+of:?\s+(?:([\w.-]+\/[\w.-]+))?#([1-9][0-9]*)(?![\w/-])/gi;
  return [...rendered.matchAll(pattern)].some(
    (match) =>
      Number(match[2]) === issue &&
      (!match[1] || match[1].toLowerCase() === repository.toLowerCase())
  );
}

async function connectedPullRequests(context: IssueContext): Promise<number[]> {
  const repository = context.payload.repository.full_name.toLowerCase();
  const numbers = new Set<number>();
  let cursor: string | null = null;
  do {
    const result: {
      repository: {
        issue: {
          timelineItems: Page<{ source?: Reference; subject?: Reference }>;
        };
      };
    } = await context.octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            timelineItems(first: 100, after: $cursor,
              itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
              nodes {
                ... on CrossReferencedEvent {
                  source { ... on PullRequest { number repository { nameWithOwner } } }
                }
                ... on ConnectedEvent {
                  source { ... on PullRequest { number repository { nameWithOwner } } }
                  subject { ... on PullRequest { number repository { nameWithOwner } } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      context.repo({ number: context.payload.issue.number, cursor })
    );
    const page = result.repository.issue.timelineItems;
    for (const node of page.nodes) {
      // Manual links may be made from either endpoint. The other endpoint can
      // be an Issue (an empty fragment), and deleted nodes may be null.
      for (const pr of [node?.source, node?.subject]) {
        if (pr?.repository?.nameWithOwner.toLowerCase() === repository) {
          numbers.add(pr.number);
        }
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return [...numbers];
}

async function closesIssue(context: IssueContext, prNumber: number) {
  const repository = context.payload.repository.full_name.toLowerCase();
  let cursor: string | null = null;
  do {
    const result: {
      repository: { pullRequest: { closingIssuesReferences: Page<Reference> } };
    } = await context.octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 100, after: $cursor) {
              nodes { number repository { nameWithOwner } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      context.repo({ number: prNumber, cursor })
    );
    const page = result.repository.pullRequest.closingIssuesReferences;
    if (
      page.nodes.some(
        (issue) =>
          issue?.number === context.payload.issue.number &&
          issue.repository.nameWithOwner.toLowerCase() === repository
      )
    ) {
      return true;
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return false;
}

async function isInterruptedReset(context: IssueContext, number: number) {
  const events = await context.octokit.paginate(
    context.octokit.issues.listEvents,
    context.repo({ issue_number: number, per_page: 100 })
  );
  const labelEvents = events
    .filter(
      (event) =>
        (event.event === "labeled" || event.event === "unlabeled") &&
        event.label?.name === OPEN_SOURCE
    )
    .map(({ event, actor, created_at, id }) => ({
      event,
      actor,
      timestamp: Date.parse(created_at ?? ""),
      id: id ?? NaN,
    }));
  const issueLabeledAt = Date.parse(context.payload.issue.updated_at);
  if (
    !Number.isFinite(issueLabeledAt) ||
    labelEvents.some(
      (event) =>
        !Number.isFinite(event.timestamp) || !Number.isSafeInteger(event.id)
    )
  ) {
    return false;
  }
  const latest = labelEvents.sort(
    (a, b) => b.timestamp - a.timestamp || b.id - a.id
  )[0];
  // A failed POST (or process exit) after removing open source must be
  // recoverable. Only resume a bot removal after this actionable event; a
  // maintainer's later removal, or an unrelated older reset, is not consent.
  return (
    latest?.event === "unlabeled" &&
    latest.actor?.id === PYTORCH_BOT_USER_ID &&
    latest.timestamp >= issueLabeledAt
  );
}

async function retriage(context: IssueContext, number: number) {
  const { data: pr } = await context.octokit.pulls.get(
    context.repo({ pull_number: number })
  );
  const labels = pr.labels.map((label) => label.name);
  if (
    pr.state !== "open" ||
    pr.draft ||
    // Match scripts/auto_pr_triage/assess_intake.py's targets_main gate.
    (pr.base.ref !== "main" &&
      !(pr.base.ref.startsWith("gh/") && pr.base.ref.endsWith("/base"))) ||
    !labels.includes(PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE) ||
    labels.some((label) =>
      [
        "no automated triage",
        PR_STATUS_LABEL_IN_PROGRESS,
        PR_STATUS_LABEL_READY_FOR_REVIEW,
      ].includes(label)
    )
  ) {
    return;
  }
  if (
    !labels.includes(OPEN_SOURCE) &&
    !(await isInterruptedReset(context, number))
  ) {
    return;
  }
  if (
    !hasPartOfReference(
      pr.body ?? "",
      context.payload.repository.full_name,
      context.payload.issue.number
    ) &&
    !(await closesIssue(context, number))
  ) {
    // Historical backlinks and mentions in comments are not current links.
    return;
  }

  async function removeLabel(name: string) {
    try {
      await context.octokit.issues.removeLabel(
        context.repo({ issue_number: number, name })
      );
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        throw error;
      }
    }
  }

  // Reset the previous outcome before waking Auto PR Triage. Keep the missing
  // issue hold until the new entry event is sent, so intermediate label events
  // cannot accidentally advance the PR to pre-review or automated review.
  for (const name of TRIAGE_OUTCOMES) {
    if (labels.includes(name)) {
      await removeLabel(name);
    }
  }
  if (labels.includes(OPEN_SOURCE)) {
    await removeLabel(OPEN_SOURCE);
  }
  await context.octokit.issues.addLabels(
    context.repo({ issue_number: number, labels: [OPEN_SOURCE] })
  );
  await removeLabel(PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE);
  context.log(
    { pr: number, issue: context.payload.issue.number },
    "Requested re-triage for newly actionable issue"
  );
}

export default function actionableIssueBot(app: Probot) {
  app.on("issues.labeled", async (context) => {
    const { repository, issue, label } = context.payload;
    if (
      !isPyTorchPyTorch(repository.owner.login, repository.name) ||
      label?.name.toLowerCase() !== "actionable" ||
      issue.pull_request
    ) {
      return;
    }
    // Ignore an old delivery if the label has since been removed.
    const { data: current } = await context.octokit.issues.get(context.issue());
    if (
      !current.labels.some(
        (value) =>
          (typeof value === "string" ? value : value.name)?.toLowerCase() ===
          "actionable"
      )
    ) {
      return;
    }
    const limit = pLimit(4);
    const results = await Promise.allSettled(
      (
        await connectedPullRequests(context)
      ).map((number) => limit(() => retriage(context, number)))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        context.log.error(result.reason, "Actionable issue re-triage failed");
      }
    }
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Failed to re-triage some PRs for the actionable issue");
    }
  });
}
