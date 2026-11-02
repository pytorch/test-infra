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

function prEvent(
  action = "edited",
  body = "Part of #5",
  before: string | null = ""
) {
  return {
    name: "pull_request",
    id: "admission-wakeup",
    payload: {
      action,
      number: 10,
      repository: event().payload.repository,
      pull_request: {
        number: 10,
        state: "open",
        draft: false,
        body,
        updated_at: LABELED_AT,
        labels: LABELS.map((name) => ({ name })),
      },
      changes: action === "edited" ? { body: { from: before } } : {},
      label: { name: "no automated triage" },
    },
  } as any;
}

function issueLabels(
  number = 5,
  labels = ["actionable"],
  cursor: string | null = null,
  next: string | null = null
) {
  return nock("https://api.github.com")
    .post(
      "/graphql",
      (body) =>
        body.query.includes("resource(url: $issueUrl)") &&
        body.variables.issueUrl ===
          `https://github.com/${REPO}/issues/${number}` &&
        body.variables.cursor === cursor
    )
    .reply(200, {
      data: {
        resource: {
          number,
          url: `https://github.com/${REPO}/issues/${number}`,
          labels: connection(
            labels.map((name) => ({ name })),
            next
          ),
        },
      },
    });
}

function supporter(
  login = "maintainer",
  permissions: object = { triage: true },
  user: object = {}
) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/collaborators/${login}/permission`)
    .reply(200, {
      permission: "read",
      user: {
        login,
        type: "User",
        permissions: {
          triage: false,
          push: false,
          maintain: false,
          admin: false,
          ...permissions,
        },
        ...user,
      },
    });
}

test.each(["Part of #5", "PART OF: PYTORCH/PYTORCH#5", "Also part\nof #5."])(
  "adding an actionable claim wakes a blocked PR: %s",
  async (body) => {
    const scopes = [pull(10, { body }), issueLabels(), requeue(10)];
    await bot.receive(prEvent("edited", body));
    handleScope(scopes);
  }
);

test.each([
  "Fixes #5",
  "Closes: pytorch/pytorch#5",
  "This resolves https://github.com/pytorch/pytorch/issues/5.",
])(
  "new closing syntax requires a native actionable closing link: %s",
  async (body) => {
    const scopes = [
      pull(10, { body }),
      closingReferences(10, [reference(5)]),
      issueLabels(),
      requeue(10),
    ];
    await bot.receive(prEvent("edited", body));
    handleScope(scopes);
  }
);

test("link first and actionable later wakes on the issue label event", async () => {
  const body = "Part of #5";
  const initiallyNotActionable = [pull(10, { body }), issueLabels(5, [])];
  await bot.receive(prEvent("edited", body));
  handleScope(initiallyNotActionable);
  const thenActionable = [
    currentIssue(),
    timeline([{ source: reference(10) }]),
    pull(10, { body }),
    requeue(10),
  ];
  await bot.receive(event());
  handleScope(thenActionable);
});

test("actionable first and link later wakes on the body edit", async () => {
  const initiallyNotLinked = [currentIssue(), timeline([])];
  await bot.receive(event());
  handleScope(initiallyNotLinked);
  const thenLinked = [
    pull(10, { body: "Part of #5" }),
    issueLabels(),
    requeue(10),
  ];
  await bot.receive(prEvent());
  handleScope(thenLinked);
});

test.each(["ready_for_review", "reopened", "unlabeled"])(
  "%s rechecks a current actionable claim even when the payload is stale",
  async (action) => {
    const scopes = [
      pull(10, { body: "Part of #5" }),
      issueLabels(),
      requeue(10),
    ];
    const delivery = prEvent(action, "");
    Object.assign(delivery.payload.pull_request, {
      state: "closed",
      draft: true,
      labels: [],
    });
    await bot.receive(delivery);
    handleScope(scopes);
  }
);

test("reopening recognizes manual links and paginates closing links and labels", async () => {
  const scopes = [
    pull(10, { body: "No description claim" }),
    closingReferences(10, [null, reference(5, "other/repo")], null, "second"),
    closingReferences(10, [reference(5)], "second"),
    issueLabels(5, ["bug"], null, "labels2"),
    issueLabels(5, ["AcTiOnAbLe"], "labels2"),
    requeue(10),
  ];
  await bot.receive(prEvent("reopened"));
  handleScope(scopes);
});

test.each(["triage", "push", "maintain", "admin"])(
  "a new supporter with %s permission wakes triage",
  async (permission) => {
    const body = "SUPPORTED BY: @Maintainer";
    const scopes = [
      pull(10, { body, user: { login: "author" } }),
      supporter("maintainer", { [permission]: true }),
      requeue(10),
    ];
    await bot.receive(prEvent("edited", body));
    handleScope(scopes);
  }
);

test.each(["ready_for_review", "reopened", "unlabeled"])(
  "%s rechecks current supporter permission",
  async (action) => {
    const body = "Supported by @maintainer";
    const scopes = [
      pull(10, { body, user: { login: "author" } }),
      supporter(),
      requeue(10),
    ];
    await bot.receive(prEvent(action, body));
    handleScope(scopes);
  }
);

test.each([
  { state: "closed" },
  { draft: true },
  { draft: undefined },
  { base: { ref: "release/2.9" } },
  {
    labels: LABELS.filter((name) => name !== MISSING).map((name) => ({ name })),
  },
  {
    labels: LABELS.filter((name) => name !== "open source").map((name) => ({
      name,
    })),
  },
  ...["no automated triage", "in progress", "ready for review"].map((name) => ({
    labels: [...LABELS, name].map((name) => ({ name })),
  })),
])(
  "body wake-ups leave currently ineligible PRs alone: %j",
  async (overrides) => {
    const scopes = [pull(10, { body: "Part of #5", ...overrides })];
    if (
      "labels" in overrides &&
      !overrides.labels.some((label) => label.name === "open source")
    ) {
      scopes.push(resetHistory([]));
    }
    await bot.receive(prEvent());
    handleScope(scopes);
  }
);

test("new wake-ups preserve ghstack eligibility", async () => {
  const scopes = [
    pull(10, { body: "Part of #5", base: { ref: "gh/author/1/base" } }),
    issueLabels(),
    requeue(10),
  ];
  await bot.receive(prEvent());
  handleScope(scopes);
});

test.each([
  "Part of other/repo#5",
  "Part of #5extra",
  "not-part of #5",
  "<!-- Part of #5 -->",
  "`Part of #5`",
  "```\nPart of #5\n```",
  "~~~\nSupported by @maintainer\n~~~",
  "<!-- Supported by @maintainer -->",
  "`Supported by @maintainer`",
  "not-supported by @maintainer",
  "Supported by @bad--login",
  "Supported by @dependabot[bot]",
  "Supported by @maintainer[bot]",
  "Fixes other/repo#5",
  "<!-- Fixes #5 -->",
  "```\nFixes #5\n```",
  "See #5",
])("non-claims do not even fetch a PR on body edits: %s", async (body) => {
  await bot.receive(prEvent("edited", body));
});

test.each([
  ["Part of #5", "Part of #5\nMore detail"],
  ["Supported by @maintainer", "Supported by @MAINTAINER\nMore detail"],
  ["Fixes #5", "Fixes pytorch/pytorch#5"],
  ["Fixes #5", "Fixes https://github.com/pytorch/pytorch/issues/5"],
  ["Part of #5", "Removed reference"],
  [
    "Supported by @one\nSupported by @two\nSupported by @three",
    "Supported by @one\nSupported by @two\nSupported by @three\nSupported by @four",
  ],
])(
  "unchanged and removed signals do not wake on unrelated edits: %s",
  async (before, body) => {
    await bot.receive(prEvent("edited", body, before));
  }
);

test("Part of candidates have the same five-issue limit as intake", async () => {
  const body =
    "Part of #1\nPart of #2\nPart of #3\nPart of #4\nPart of #6\nPart of #5";
  const scopes = [
    pull(10, { body }),
    ...[1, 2, 3, 4, 6].map((number) => issueLabels(number, [])),
  ];
  await bot.receive(prEvent("edited", body));
  handleScope(scopes);
});

test.each(["title only", "other label removed", "other repository"])(
  "ignores %s PR events",
  async (kind) => {
    const delivery = prEvent();
    if (kind === "title only")
      delivery.payload.changes = { title: { from: "old" } };
    if (kind === "other label removed") {
      delivery.payload.action = "unlabeled";
      delivery.payload.label.name = "open source";
    }
    if (kind === "other repository")
      delivery.payload.repository.name = "vision";
    await bot.receive(delivery);
  }
);

test.each(["Part of #5", "Fixes #5", "Supported by @maintainer"])(
  "does not wake when a new claim was removed before delivery: %s",
  async (body) => {
    const scope = pull(10, {
      body: "No current signal",
      user: { login: "author" },
    });
    await bot.receive(prEvent("edited", body));
    handleScope(scope);
  }
);

test("an existing valid signal cannot substitute for a newly added invalid one", async () => {
  const before = "Part of #5";
  const body = `${before}\nPart of #6`;
  const scopes = [pull(10, { body }), issueLabels(6, [])];
  await bot.receive(prEvent("edited", body, before));
  handleScope(scopes);
});

test("closing text without a native closing link does not wake triage", async () => {
  const body = "Fixes #5";
  const scopes = [
    pull(10, { body }),
    closingReferences(10, [reference(5, "other/repo"), reference(6)]),
  ];
  await bot.receive(prEvent("edited", body));
  handleScope(scopes);
});

test.each([
  null,
  {},
  { number: 6 },
  { number: 5, url: "https://github.com/other/repo/issues/5" },
])(
  "an absent, transferred or mismatched issue is not actionable: %j",
  async (resource) => {
    const scopes = [
      pull(10, { body: "Part of #5" }),
      nock("https://api.github.com")
        .post("/graphql")
        .reply(200, { data: { resource } }),
    ];
    await bot.receive(prEvent());
    handleScope(scopes);
  }
);

test.each(["author", "pytorchbot", "pytorchmergebot"])(
  "does not accept author or known bot supporter %s",
  async (login) => {
    const body = `Supported by @${login}`;
    const scope = pull(10, { body, user: { login: "AUTHOR" } });
    await bot.receive(prEvent("edited", body));
    handleScope(scope);
  }
);

test.each([
  [{ triage: false }, {}],
  [{ triage: true }, { type: "Bot" }],
  [{ triage: true }, { type: "Organization" }],
])(
  "does not accept an unprivileged or nonhuman supporter: %j",
  async (permissions, user) => {
    const body = "Supported by @maintainer";
    const scopes = [
      pull(10, { body, user: { login: "author" } }),
      supporter("maintainer", permissions, user),
    ];
    await bot.receive(prEvent("edited", body));
    handleScope(scopes);
  }
);

test("unknown supporter does not wake triage", async () => {
  const body = "Supported by @unknown";
  const scopes = [
    pull(10, { body, user: { login: "author" } }),
    nock("https://api.github.com")
      .get(`/repos/${REPO}/collaborators/unknown/permission`)
      .reply(404),
  ];
  await bot.receive(prEvent("edited", body));
  handleScope(scopes);
});

test.each([
  {
    login: "another-person",
    type: "User",
    permissions: { triage: true, push: false, maintain: false, admin: false },
  },
  { login: "maintainer", type: "User", permissions: { triage: true } },
  {
    login: "maintainer",
    type: undefined,
    permissions: { triage: true, push: false, maintain: false, admin: false },
  },
  {
    login: "maintainer",
    type: "User",
    permissions: { triage: "true", push: false, maintain: false, admin: false },
  },
])(
  "incomplete supporter identity or permissions fails closed: %j",
  async (user) => {
    const body = "Supported by @maintainer";
    const scopes = [
      pull(10, { body, user: { login: "author" } }),
      supporter("maintainer", {}, user),
    ];
    await expect(bot.receive(prEvent("edited", body))).rejects.toThrow(
      "Incomplete supporter permissions"
    );
    handleScope(scopes);
  }
);

test("permission lookup failure fails closed without label writes", async () => {
  const body = "Supported by @maintainer";
  const scopes = [
    pull(10, { body, user: { login: "author" } }),
    nock("https://api.github.com")
      .get(`/repos/${REPO}/collaborators/maintainer/permission`)
      .reply(503),
  ];
  await expect(bot.receive(prEvent("edited", body))).rejects.toThrow();
  handleScope(scopes);
});

test("a failed issue-label page does not clear the hold even after finding actionable", async () => {
  const scopes = [
    pull(10, { body: "Part of #5" }),
    issueLabels(5, ["actionable"], null, "labels2"),
    nock("https://api.github.com")
      .post("/graphql", (body) => body.variables.cursor === "labels2")
      .reply(503),
  ];
  await expect(bot.receive(prEvent())).rejects.toThrow();
  handleScope(scopes);
});

test.each([null, "repeat"])(
  "incomplete closing pagination fails closed: %j",
  async (cursor) => {
    const scopes = [pull(10, { body: "Fixes #5" })];
    if (cursor) scopes.push(closingReferences(10, [], null, cursor));
    scopes.push(
      nock("https://api.github.com")
        .post("/graphql", (body) => body.variables.cursor === cursor)
        .reply(200, {
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  nodes: [reference(5)],
                  pageInfo: { hasNextPage: true, endCursor: cursor },
                },
              },
            },
          },
        })
    );
    await expect(bot.receive(prEvent("edited", "Fixes #5"))).rejects.toThrow(
      "Incomplete GitHub pagination"
    );
    handleScope(scopes);
  }
);

test("a failed outcome reset on an edit retains the hold and succeeds on redelivery", async () => {
  const delivery = prEvent();
  const failed = [
    pull(10, { body: "Part of #5" }),
    issueLabels(),
    nock("https://api.github.com")
      .delete(`/repos/${REPO}/issues/10/labels/triaged`)
      .reply(503),
  ];
  await expect(bot.receive(delivery)).rejects.toThrow();
  handleScope(failed);
  const retry = [pull(10, { body: "Part of #5" }), issueLabels(), requeue(10)];
  await bot.receive(delivery);
  handleScope(retry);
  const alreadyAdvanced = pull(10, {
    body: "Part of #5",
    labels: [{ name: "open source" }],
  });
  await bot.receive(delivery);
  handleScope(alreadyAdvanced);
});

function resetHistory(events: object[]) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/issues/10/events?per_page=100`)
    .reply(200, events);
}

test.each(["edited", "reopened"])(
  "failed trigger on %s recovers on replay using the original event timestamp",
  async (action) => {
    const delivery = prEvent(action);
    const reset = nock("https://api.github.com");
    for (const name of ["triaged", "bot-triaged", "open source"]) {
      reset
        .delete(`/repos/${REPO}/issues/10/labels/${encodeURIComponent(name)}`)
        .reply(200, []);
    }
    reset
      .post(`/repos/${REPO}/issues/10/labels`, { labels: ["open source"] })
      .reply(503);
    const failed = [pull(10, { body: "Part of #5" }), issueLabels(), reset];
    await expect(bot.receive(delivery)).rejects.toThrow();
    handleScope(failed);

    // Later live updates must not replace the failed delivery's provenance.
    const retry = [
      pull(10, {
        body: "Part of #5",
        updated_at: "2026-10-30T05:00:00Z",
        labels: [{ name: MISSING }],
      }),
      resetHistory([botRemoval()]),
      issueLabels(),
      requeue(10, [], false),
    ];
    await bot.receive(delivery);
    handleScope(retry);
  }
);

test.each(["edited", "reopened"])(
  "a later human removal prevents %s redelivery from restoring opt-in",
  async (action) => {
    const scopes = [
      pull(10, { body: "Part of #5", labels: [{ name: MISSING }] }),
      resetHistory([botRemoval(), botRemoval({ id: 3, actor: { id: 123 } })]),
    ];
    await bot.receive(prEvent(action));
    handleScope(scopes);
  }
);

test.each([
  { events: [] },
  { events: [botRemoval({ created_at: "2026-10-29T00:00:00Z" })] },
])(
  "PR events require current reset provenance before restoring absent opt-in: %j",
  async ({ events }) => {
    const scopes = [
      pull(10, { body: "Part of #5", labels: [{ name: MISSING }] }),
      resetHistory(events),
    ];
    await bot.receive(prEvent());
    handleScope(scopes);
  }
);

test("PR events with invalid timestamps cannot recover a missing opt-in", async () => {
  const delivery = prEvent();
  delivery.payload.pull_request.updated_at = "invalid";
  const scopes = [
    pull(10, { body: "Part of #5", labels: [{ name: MISSING }] }),
    resetHistory([botRemoval()]),
  ];
  await bot.receive(delivery);
  handleScope(scopes);
});

test.each(["main", "release/2.9"])(
  "upstream base gate does not follow a changed default branch: %s",
  async (base) => {
    const delivery = prEvent();
    delivery.payload.repository.default_branch = "release/2.9";
    const scopes = [pull(10, { body: "Part of #5", base: { ref: base } })];
    if (base === "main") scopes.push(issueLabels(), requeue(10));
    await bot.receive(delivery);
    handleScope(scopes);
  }
);
