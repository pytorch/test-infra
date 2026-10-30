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
type WakeupContext = Context<
  | "issues.labeled"
  | "pull_request.edited"
  | "pull_request.ready_for_review"
  | "pull_request.reopened"
  | "pull_request.unlabeled"
>;
type Claims = {
  partOf: number[];
  closing: number[];
  supporters: string[];
};
type Trigger = { eventAt: string } & ({ issue: number } | { added?: Claims });
type Reference = { number: number; repository: { nameWithOwner: string } };
type Page<T> = {
  nodes: (T | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

// Match Auto PR Triage's rendered description claims and candidate limits.
// Reject [bot] suffixes as well, so they cannot claim a human login prefix.
// Closing syntax is only a change detector: GitHub must verify the link too.
function descriptionClaims(body: string, repository: string): Claims {
  const rendered = body.replace(
    /<!--[\s\S]*?(?:-->|$)|(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g,
    " "
  );
  const sameRepository = (repo?: string) =>
    !repo || repo.toLowerCase() === repository.toLowerCase();
  const issueNumbers = (matches: Iterable<RegExpMatchArray>) => [
    ...new Set(
      [...matches]
        .filter((match) => sameRepository(match[1]))
        .map((match) => Number(match[2]))
        .filter(Number.isSafeInteger)
    ),
  ];
  const partOf = issueNumbers(
    rendered.matchAll(
      /(?<![\w-])part\s+of:?\s+(?:([\w.-]+\/[\w.-]+))?#([1-9][0-9]*)(?![\w/-])/gi
    )
  ).slice(0, 5);
  const closing = issueNumbers(
    rendered.matchAll(
      /(?<![\w-])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):?\s+(?:(?:([\w.-]+\/[\w.-]+))?#)([1-9][0-9]*)(?![\w/-])/gi
    )
  );
  closing.push(
    ...issueNumbers(
      rendered.matchAll(
        /(?<![\w-])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):?\s+https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]*)(?![\w/-])/gi
      )
    )
  );
  const supporters = [
    ...new Set(
      [
        ...rendered.matchAll(
          /(?<![\w-])supported\s+by:?\s+@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![\w/\[-])/gi
        ),
      ].map((match) => match[1].toLowerCase())
    ),
  ].slice(0, 3);
  return { partOf, closing: [...new Set(closing)], supporters };
}

function addedClaims(previous: Claims, current: Claims): Claims {
  return {
    partOf: current.partOf.filter(
      (number) => !previous.partOf.includes(number)
    ),
    closing: current.closing.filter(
      (number) => !previous.closing.includes(number)
    ),
    supporters: current.supporters.filter(
      (login) => !previous.supporters.includes(login)
    ),
  };
}

function nextCursor<T>(page: Page<T>, seen: Set<string>): string | null {
  if (
    !Array.isArray(page.nodes) ||
    typeof page.pageInfo.hasNextPage !== "boolean"
  ) {
    throw new Error("Incomplete GitHub connection");
  }
  if (!page.pageInfo.hasNextPage) return null;
  const cursor = page.pageInfo.endCursor;
  if (typeof cursor !== "string" || !cursor || seen.has(cursor)) {
    throw new Error("Incomplete GitHub pagination");
  }
  seen.add(cursor);
  return cursor;
}

async function connectedPullRequests(context: IssueContext): Promise<number[]> {
  const repository = context.payload.repository.full_name.toLowerCase();
  const numbers = new Set<number>();
  const seen = new Set<string>();
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
    cursor = nextCursor(page, seen);
  } while (cursor);
  return [...numbers];
}

async function closingIssues(context: WakeupContext, prNumber: number) {
  const repository = context.payload.repository.full_name.toLowerCase();
  const numbers = new Set<number>();
  const seen = new Set<string>();
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
    cursor = nextCursor(page, seen);
    for (const issue of page.nodes) {
      if (issue?.repository.nameWithOwner.toLowerCase() === repository) {
        if (!Number.isSafeInteger(issue.number) || issue.number < 1) {
          throw new Error("Invalid linked issue number");
        }
        numbers.add(issue.number);
      }
    }
  } while (cursor);
  return numbers;
}

async function isActionableIssue(context: WakeupContext, number: number) {
  const url = `https://github.com/${context.payload.repository.full_name}/issues/${number}`;
  const seen = new Set<string>();
  let cursor: string | null = null;
  let actionable = false;
  do {
    const result: {
      resource: {
        number: number;
        url: string;
        labels: Page<{ name: string }>;
      } | null;
    } = await context.octokit.graphql(
      `query($issueUrl: URI!, $cursor: String) {
        resource(url: $issueUrl) {
          ... on Issue {
            number url
            labels(first: 100, after: $cursor) {
              nodes { name }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { issueUrl: url, cursor }
    );
    const issue = result.resource;
    // Deleted issues, PRs and transferred issues are not same-repository issues.
    if (!issue || Object.keys(issue).length === 0) return false;
    if (
      issue.number !== number ||
      issue.url.toLowerCase() !== url.toLowerCase()
    ) {
      return false;
    }
    cursor = nextCursor(issue.labels, seen);
    for (const label of issue.labels.nodes) {
      if (typeof label?.name !== "string") {
        throw new Error("Incomplete issue labels");
      }
      actionable ||= label.name.toLowerCase() === "actionable";
    }
  } while (cursor);
  return actionable;
}

async function isSupporter(
  context: WakeupContext,
  login: string,
  author: string
) {
  if (
    login === author.toLowerCase() ||
    ["pytorchbot", "pytorchmergebot"].includes(login) ||
    login.endsWith("[bot]")
  )
    return false;
  let data;
  try {
    ({ data } = await context.octokit.repos.getCollaboratorPermissionLevel(
      context.repo({ username: login })
    ));
  } catch (error) {
    if ((error as { status?: number }).status === 404) return false;
    throw error;
  }
  const user = data.user;
  const permissions = user?.permissions;
  const access = ["triage", "push", "maintain", "admin"] as const;
  // Require the same granular permission facts as intake, including triage.
  // Support is admission only; it does not grant merge approval.
  if (
    user?.login?.toLowerCase() !== login ||
    typeof user.type !== "string" ||
    !permissions ||
    access.some((name) => typeof permissions[name] !== "boolean")
  )
    throw new Error("Incomplete supporter permissions");
  return user.type === "User" && access.some((name) => permissions[name]);
}

async function hasAdmissionSignal(
  context: WakeupContext,
  number: number,
  body: string,
  author: string | undefined,
  trigger: Trigger
) {
  const current = descriptionClaims(body, context.payload.repository.full_name);
  if ("issue" in trigger) {
    return (
      current.partOf.includes(trigger.issue) ||
      (await closingIssues(context, number)).has(trigger.issue)
    );
  }
  const partOf = current.partOf.filter(
    (issue) => !trigger.added || trigger.added.partOf.includes(issue)
  );
  const supporters = current.supporters.filter(
    (login) => !trigger.added || trigger.added.supporters.includes(login)
  );
  const closing = current.closing.filter((issue) =>
    trigger.added?.closing.includes(issue)
  );
  for (const issue of partOf) {
    if (await isActionableIssue(context, issue)) return true;
  }
  if (author) {
    for (const login of supporters) {
      if (await isSupporter(context, login, author)) return true;
    }
  }
  // Lifecycle wake-ups also recognize links made through GitHub's UI. An edit
  // must introduce closing syntax as well as have a native closing reference,
  // preventing unrelated edits from repeatedly waking a still-blocked PR.
  if (!trigger.added || closing.length) {
    for (const issue of await closingIssues(context, number)) {
      if (
        (!trigger.added || closing.includes(issue)) &&
        (await isActionableIssue(context, issue))
      )
        return true;
    }
  }
  return false;
}

async function isInterruptedReset(
  context: WakeupContext,
  number: number,
  eventAt: string
) {
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
  const triggeredAt = Date.parse(eventAt);
  if (
    !Number.isFinite(triggeredAt) ||
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
  // recoverable. Only resume a bot removal after the original webhook event; a
  // maintainer's later removal, or an unrelated older reset, is not consent.
  return (
    latest?.event === "unlabeled" &&
    latest.actor?.id === PYTORCH_BOT_USER_ID &&
    latest.timestamp >= triggeredAt
  );
}

async function retriage(
  context: WakeupContext,
  number: number,
  trigger: Trigger
) {
  const { data: pr } = await context.octokit.pulls.get(
    context.repo({ pull_number: number })
  );
  const labels = pr.labels.map((label) => label.name.toLowerCase());
  if (
    pr.state !== "open" ||
    pr.draft !== false ||
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
    !(await isInterruptedReset(context, number, trigger.eventAt))
  ) {
    return;
  }
  if (
    !(await hasAdmissionSignal(
      context,
      number,
      pr.body ?? "",
      pr.user?.login,
      trigger
    ))
  ) {
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
    { pr: number, trigger },
    "Requested re-triage after admission signal changed"
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
      ).map((number) =>
        limit(() =>
          retriage(context, number, {
            issue: issue.number,
            eventAt: issue.updated_at,
          })
        )
      )
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
  app.on(
    [
      "pull_request.edited",
      "pull_request.ready_for_review",
      "pull_request.reopened",
      "pull_request.unlabeled",
    ],
    async (context) => {
      const { repository, pull_request: pr } = context.payload;
      if (!isPyTorchPyTorch(repository.owner.login, repository.name)) return;
      // Use the immutable delivery timestamp, never the later live PR update.
      const trigger: { eventAt: string; added?: Claims } = {
        eventAt: pr.updated_at,
      };
      if (
        context.payload.action === "unlabeled" &&
        context.payload.label?.name.toLowerCase() !== "no automated triage"
      )
        return;
      if (context.payload.action === "edited") {
        const change = context.payload.changes?.body;
        if (
          !change ||
          (change.from !== null && typeof change.from !== "string")
        )
          return;
        trigger.added = addedClaims(
          descriptionClaims(change.from ?? "", repository.full_name),
          descriptionClaims(pr.body ?? "", repository.full_name)
        );
        if (!Object.values(trigger.added).some((claims) => claims.length))
          return;
      }
      await retriage(context, pr.number, trigger);
    }
  );
}
