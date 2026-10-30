import actionableIssueBot from "lib/bot/actionableIssueBot";
import { PYTORCH_BOT_USER_ID } from "lib/bot/Constants";
import nock from "nock";
import { handleScope, requireDeepCopy } from "./common";
import { testProbot } from "./utils";

nock.disableNetConnect();
const REPO = "pytorch/pytorch";
const MISSING = "missing actionable issue";
const LABELS = ["open source", "triaged", "bot-triaged", MISSING];
const LABELED_AT = "2026-10-30T04:00:00Z";

function event() {
  const payload = requireDeepCopy("./fixtures/issues.labeled.json");
  Object.assign(payload.repository, {
    owner: { login: "pytorch" },
    name: "pytorch",
    full_name: REPO,
    default_branch: "main",
  });
  payload.issue.number = 5;
  payload.issue.updated_at = LABELED_AT;
  payload.issue.labels = [{ name: "actionable" }];
  payload.label.name = "actionable";
  return { name: "issues", payload, id: "actionable" } as any;
}

function currentIssue(labels = ["actionable"]) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/issues/5`)
    .reply(200, { labels: labels.map((name) => ({ name })) });
}

function reference(number: number, repo = REPO) {
  return { number, repository: { nameWithOwner: repo } };
}

function connection(nodes: (object | null)[], next: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } };
}

function timeline(
  nodes: (object | null)[],
  cursor: string | null = null,
  next: string | null = null
) {
  return nock("https://api.github.com")
    .post("/graphql", (body) => {
      expect(body.query).toMatch(/\.\.\. on ConnectedEvent\s*\{\s*source\s*\{/);
      return (
        body.query.includes("CROSS_REFERENCED_EVENT, CONNECTED_EVENT") &&
        body.variables.owner === "pytorch" &&
        body.variables.repo === "pytorch" &&
        body.variables.number === 5 &&
        body.variables.cursor === cursor
      );
    })
    .reply(200, {
      data: {
        repository: { issue: { timelineItems: connection(nodes, next) } },
      },
    });
}

function closingReferences(
  number: number,
  nodes: (object | null)[],
  cursor: string | null = null,
  next: string | null = null
) {
  return nock("https://api.github.com")
    .post(
      "/graphql",
      (body) =>
        body.query.includes("closingIssuesReferences") &&
        body.variables.number === number &&
        body.variables.cursor === cursor
    )
    .reply(200, {
      data: {
        repository: {
          pullRequest: { closingIssuesReferences: connection(nodes, next) },
        },
      },
    });
}

function pull(number: number, overrides: object = {}) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/pulls/${number}`)
    .reply(200, {
      state: "open",
      draft: false,
      base: { ref: "main" },
      body: "Fixes #5",
      labels: LABELS.map((name) => ({ name })),
      ...overrides,
    });
}

function requeue(
  number: number,
  outcomes = ["triaged", "bot-triaged"],
  hasOpenSource = true
) {
  const order: string[] = [];
  const expected = [...outcomes, ...(hasOpenSource ? ["open source"] : [])];
  const scope = nock("https://api.github.com");
  for (const name of expected) {
    scope
      .delete(
        `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(name)}`
      )
      .reply(() => {
        order.push(name);
        return [200, []];
      });
  }
  scope
    .post(`/repos/${REPO}/issues/${number}/labels`, { labels: ["open source"] })
    .reply(() => {
      expect(order).toEqual(expected);
      order.push("trigger");
      return [200, []];
    })
    .delete(
      `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(MISSING)}`
    )
    .reply(() => {
      expect(order).toEqual([...expected, "trigger"]);
      return [200, []];
    });
  return scope;
}

const bot = testProbot();
bot.load(actionableIssueBot);
afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

test("re-triages all linked blocked PRs, paginates both connections, and deduplicates backlinks", async () => {
  const scopes = [
    currentIssue(),
    timeline(
      [
        { source: reference(10) },
        { source: {}, subject: reference(11) },
        { source: {} },
        null,
      ],
      null,
      "page2"
    ),
    timeline(
      [
        { source: reference(10) },
        { source: reference(12, "pytorch/vision") },
        { source: reference(13), subject: {} },
      ],
      "page2"
    ),
    pull(10),
    closingReferences(10, [null, reference(5, "other/repo")], null, "linked2"),
    closingReferences(10, [reference(5)], "linked2"),
    pull(11, { body: "See this manually linked issue" }),
    closingReferences(11, [reference(5)]),
    pull(13, { body: "Another manually linked issue" }),
    closingReferences(13, [reference(5)]),
    requeue(10),
    requeue(11),
    requeue(13),
  ];
  await bot.receive(event());
  handleScope(scopes);
});

test.each(["Part of #5", "PART OF: PYTORCH/PYTORCH#5", "This is part\nof #5."])(
  "re-triages a current description claim: %s",
  async (body) => {
    const scopes = [
      currentIssue(),
      timeline([{ source: reference(10) }]),
      pull(10, { body }),
      requeue(10),
    ];
    await bot.receive(event());
    handleScope(scopes);
  }
);

test.each([
  "The old reference was removed",
  "Part of #50",
  "Part of other/repo#5",
  "<!-- Part of #5 -->",
  "`Part of #5`",
  "```\nPart of #5\n```",
  "~~~\nPart of #5\n~~~",
  "not-part of #5",
  "Part of #5extra",
])("ignores obsolete backlinks and non-claims: %s", async (body) => {
  const scopes = [
    currentIssue(),
    timeline([{ source: reference(10) }]),
    pull(10, { body }),
    closingReferences(10, []),
  ];
  await bot.receive(event());
  handleScope(scopes);
});

test.each([
  { state: "closed" },
  { draft: true },
  { base: { ref: "release/2.9" } },
  {
    labels: LABELS.filter((name) => name !== MISSING).map((name) => ({ name })),
  },
  {
    labels: LABELS.filter((name) => name !== "open source").map((name) => ({
      name,
    })),
  },
  ...["no automated triage", "in progress", "ready for review"].map(
    (label) => ({ labels: [...LABELS, label].map((name) => ({ name })) })
  ),
])(
  "leaves ineligible PRs and successful redeliveries alone: %j",
  async (overrides) => {
    const scopes = [
      currentIssue(),
      timeline([{ source: reference(10) }]),
      pull(10, overrides),
    ];
    if (
      "labels" in overrides &&
      !overrides.labels.some((label) => label.name === "open source")
    ) {
      scopes.push(
        nock("https://api.github.com")
          .get(`/repos/${REPO}/issues/10/events?per_page=100`)
          .reply(200, [])
      );
    }
    await bot.receive(event());
    handleScope(scopes);
  }
);

test.each(["another label", "another repository", "pull request"])(
  "ignores %s events",
  async (kind) => {
    const delivery = event();
    if (kind === "another label") delivery.payload.label.name = "bug";
    if (kind === "another repository")
      delivery.payload.repository.name = "vision";
    if (kind === "pull request") delivery.payload.issue.pull_request = {};
    await bot.receive(delivery);
  }
);

test("ignores a delayed event after actionable was removed", async () => {
  const scope = currentIssue([]);
  await bot.receive(event());
  handleScope(scope);
});

test("clears a previous triage error along with the blocked outcome", async () => {
  const scopes = [
    currentIssue(),
    timeline([{ source: reference(10) }]),
    pull(10, {
      body: "Part of #5",
      labels: [...LABELS, "bot-triage-error"].map((name) => ({ name })),
    }),
    requeue(10, ["triaged", "bot-triaged", "bot-triage-error"]),
  ];
  await bot.receive(event());
  handleScope(scopes);
});

test("a failed PR read does not prevent other linked PRs from being re-triaged", async () => {
  const scopes = [
    currentIssue(),
    timeline([{ source: reference(10) }, { source: reference(11) }]),
    nock("https://api.github.com").get(`/repos/${REPO}/pulls/10`).reply(503),
    pull(11, { body: "Part of #5" }),
    requeue(11),
  ];
  await expect(bot.receive(event())).rejects.toThrow(
    "Failed to re-triage some PRs"
  );
  handleScope(scopes);
});

test("a failed outcome reset leaves the hold in place and does not trigger triage", async () => {
  const scopes = [
    currentIssue(),
    timeline([{ source: reference(10) }]),
    pull(10, { body: "Part of #5" }),
    nock("https://api.github.com")
      .delete(`/repos/${REPO}/issues/10/labels/triaged`)
      .reply(503),
  ];
  await expect(bot.receive(event())).rejects.toThrow(
    "Failed to re-triage some PRs"
  );
  handleScope(scopes);
});

test("re-triages ghstack base branches supported by Auto PR Triage", async () => {
  const scopes = [
    currentIssue(),
    timeline([{ source: reference(10) }]),
    pull(10, { body: "Part of #5", base: { ref: "gh/jansel/1/base" } }),
    requeue(10),
  ];
  await bot.receive(event());
  handleScope(scopes);
});

function botRemoval(overrides: object = {}) {
  return {
    id: 2,
    event: "unlabeled",
    label: { name: "open source" },
    actor: { id: PYTORCH_BOT_USER_ID },
    created_at: "2026-10-30T04:00:01Z",
    ...overrides,
  };
}

test("a redelivery recovers a failed trigger using paginated bot-removal history", async () => {
  const reset = nock("https://api.github.com");
  for (const name of ["triaged", "bot-triaged", "open source"]) {
    reset
      .delete(`/repos/${REPO}/issues/10/labels/${encodeURIComponent(name)}`)
      .reply(200, []);
  }
  reset
    .post(`/repos/${REPO}/issues/10/labels`, { labels: ["open source"] })
    .reply(503);
  const failedScopes = [
    currentIssue(),
    timeline([{ source: reference(10) }]),
    pull(10, { body: "Part of #5" }),
    reset,
  ];
  await expect(bot.receive(event())).rejects.toThrow(
    "Failed to re-triage some PRs"
  );
  handleScope(failedScopes);

  // Only the hold remains after the failed POST. The successful replay must
  // restore the trigger without clearing the hold before the POST succeeds.
  const history = nock("https://api.github.com")
    .get(`/repos/${REPO}/issues/10/events?per_page=100`)
    .reply(200, [botRemoval({ id: 1, created_at: "2026-10-29T00:00:00Z" })], {
      Link: `<https://api.github.com/repos/${REPO}/issues/10/events?per_page=100&page=2>; rel="next"`,
    })
    .get(`/repos/${REPO}/issues/10/events?per_page=100&page=2`)
    .reply(200, [botRemoval()]);
  const retryScopes = [
    currentIssue(),
    timeline([{ source: reference(10) }]),
    pull(10, { body: "Part of #5", labels: [{ name: MISSING }] }),
    history,
    requeue(10, [], false),
  ];
  await bot.receive(event());
  handleScope(retryScopes);
});

test.each(
  [
    [botRemoval({ created_at: "2026-10-29T00:00:00Z" })],
    [botRemoval({ created_at: "invalid" })],
    [
      botRemoval(),
      botRemoval({ id: 1, actor: { id: 123 }, created_at: "invalid" }),
    ],
    [botRemoval({ actor: null })],
    [botRemoval({ event: "labeled" })],
    [botRemoval(), botRemoval({ id: 3, actor: { id: 123 } })],
    [
      botRemoval({
        id: 3,
        actor: { id: 123 },
        created_at: "2026-10-30T05:00:00Z",
      }),
      botRemoval(),
    ],
  ].map((events) => ({ events }))
)(
  "does not restore absent open source without a current bot reset: %j",
  async ({ events }) => {
    const scopes = [
      currentIssue(),
      timeline([{ source: reference(10) }]),
      pull(10, { body: "Part of #5", labels: [{ name: MISSING }] }),
      nock("https://api.github.com")
        .get(`/repos/${REPO}/issues/10/events?per_page=100`)
        .reply(200, events),
    ];
    await bot.receive(event());
    handleScope(scopes);
  }
);
