import { generateKeyPairSync } from "crypto";
import { clearInstallationIdCache } from "lib/bot/greenlightAppAuth";
import greenlightBot from "lib/bot/greenlightBot";
import {
  clearRecheckDedupe,
  RECHECK_DEDUPE_TTL_MS,
} from "lib/bot/greenlightBotHandler";
import nock from "nock";
import { Probot } from "probot";
import { handleScope } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const SOURCE_INSTALLATION_ID = 11;
const DISPATCH_INSTALLATION_ID = 22;

// On the TRUSTED_AUTHORS list the backend gates rechecks on.
const TRUSTED_LOGIN = "huydhn";

let privateKey: string;

interface Recorded {
  calls: string[];
  comments: string[];
  reactions: string[];
  tokenRequests: any[];
  dispatch: any;
  unmatched: string[];
}

let recorded: Recorded;

function greenlightEvent({
  owner = "pytorch",
  repo = "pytorch",
  action = "created",
  body = "@greenlight recheck",
  login = TRUSTED_LOGIN,
  userType = "User",
  state = "open",
  draft = false,
  mergedAt = null as string | null,
  labels = [] as { name: string }[],
  isPullRequest = true,
  prNumber = 31,
  commentId = 890173751,
  installationId = SOURCE_INSTALLATION_ID as number | null,
} = {}) {
  const htmlUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  return {
    name: "issue_comment",
    id: "7835ed00-f180-11eb-9c94-b7c265ade873",
    payload: {
      action,
      installation:
        installationId === null ? undefined : { id: installationId },
      issue: {
        number: prNumber,
        state,
        draft,
        labels,
        html_url: htmlUrl,
        pull_request: isPullRequest ? { merged_at: mergedAt } : undefined,
      },
      comment: {
        id: commentId,
        body,
        html_url: `${htmlUrl}#issuecomment-${commentId}`,
        user: { login, type: userType },
      },
      repository: {
        name: repo,
        full_name: `${owner}/${repo}`,
        owner: { login: owner },
      },
    },
  };
}

function mockInstallationLookup(
  repoFullName: string,
  installationId: number,
  status: number = 200
) {
  return nock("https://api.github.com")
    .get(`/repos/${repoFullName}/installation`)
    .reply(status, () => {
      recorded.calls.push(
        status === 200 ? "installation-lookup" : `installation-lookup-${status}`
      );
      return { id: installationId };
    });
}

function mockAccessToken(installationId: number, status: number = 201) {
  return nock("https://api.github.com")
    .post(`/app/installations/${installationId}/access_tokens`)
    .reply(status, (_uri, body: any) => {
      recorded.tokenRequests.push(body);
      if (status !== 201) {
        recorded.calls.push(`access-token-${status}`);
      }
      return { token: `token-${installationId}` };
    });
}

function mockSourceToken() {
  return mockAccessToken(SOURCE_INSTALLATION_ID);
}

function mockDispatchToken(withLookup: boolean = true) {
  const scopes = withLookup
    ? [mockInstallationLookup("pytorch/test-infra", DISPATCH_INSTALLATION_ID)]
    : [];
  return [...scopes, mockAccessToken(DISPATCH_INSTALLATION_ID)];
}

function mockComment(repoFullName: string, prNumber: number = 31) {
  return nock("https://api.github.com")
    .post(`/repos/${repoFullName}/issues/${prNumber}/comments`)
    .reply(201, (_uri, body: any) => {
      recorded.calls.push("comment");
      recorded.comments.push(body.body);
      return {};
    });
}

function mockRemoveLabel(
  repoFullName: string,
  label: string = "Stale",
  prNumber: number = 31,
  status: number = 200
) {
  return nock("https://api.github.com")
    .delete(`/repos/${repoFullName}/issues/${prNumber}/labels/${label}`)
    .reply(status, () => {
      recorded.calls.push(status === 200 ? "unlabel" : `unlabel-${status}`);
      return [];
    });
}

function mockReaction(
  repoFullName: string,
  commentId: number = 890173751
): nock.Scope {
  return nock("https://api.github.com")
    .post(`/repos/${repoFullName}/issues/comments/${commentId}/reactions`)
    .reply(201, (_uri, body: any) => {
      recorded.calls.push("react");
      recorded.reactions.push(body.content);
      return {};
    });
}

function mockDispatch(status: number = 204) {
  return nock("https://api.github.com")
    .post(
      "/repos/pytorch/test-infra/actions/workflows/greenlight-review.yml/dispatches"
    )
    .reply(status, (_uri, body: any) => {
      recorded.calls.push(status === 204 ? "dispatch" : `dispatch-${status}`);
      recorded.dispatch = body;
      return "";
    });
}

/** Every scoped token minted during the delivery, ordered by the repo it covers. */
function tokenRequestsByRepo() {
  return [...recorded.tokenRequests].sort((a, b) =>
    a.repositories[0].localeCompare(b.repositories[0])
  );
}

describe("greenlight-bot", () => {
  let probot: Probot;

  beforeAll(() => {
    privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;
  });

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(greenlightBot);
    clearRecheckDedupe();
    clearInstallationIdCache();
    recorded = {
      calls: [],
      comments: [],
      reactions: [],
      tokenRequests: [],
      dispatch: undefined,
      unmatched: [],
    };
    nock.emitter.on("no match", (req: any) => {
      recorded.unmatched.push(`${req.method} ${req.path}`);
    });
    process.env.GREENLIGHT_BOT_REPOS = "pytorch/pytorch";
    process.env.GREENLIGHT_APP_ID = "4441283";
    process.env.GREENLIGHT_APP_PRIVATE_KEY = privateKey;
  });

  afterEach(() => {
    const unmatched = [...recorded.unmatched];
    nock.emitter.removeAllListeners("no match");
    nock.cleanAll();
    jest.restoreAllMocks();
    delete process.env.GREENLIGHT_BOT_REPOS;
    delete process.env.GREENLIGHT_APP_ID;
    delete process.env.GREENLIGHT_APP_PRIVATE_KEY;
    // A request the test did not mock would otherwise be swallowed by the
    // handler's own error handling and pass silently. Asserted after the
    // cleanup, so one failing test does not leak interceptors into the next.
    expect(unmatched).toEqual([]);
  });

  async function receive(event: any) {
    await probot.receive(event);
  }

  test("unlabels and dispatches before it acknowledges", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockRemoveLabel("pytorch/pytorch"),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ labels: [{ name: "Stale" }] }));

    expect(recorded.calls).toEqual([
      "installation-lookup",
      "unlabel",
      "dispatch",
      "comment",
      "react",
    ]);
    expect(recorded.dispatch).toEqual({
      ref: "main",
      inputs: { pr: "31", requester: TRUSTED_LOGIN },
    });
    expect(recorded.reactions).toEqual(["+1"]);
    handleScope(scopes);
  });

  test("mints one narrowly scoped token per repo it writes to", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockRemoveLabel("pytorch/pytorch"),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ labels: [{ name: "Stale" }] }));

    expect(tokenRequestsByRepo()).toEqual([
      { repositories: ["pytorch"], permissions: { issues: "write" } },
      { repositories: ["test-infra"], permissions: { actions: "write" } },
    ]);
    handleScope(scopes);
  });

  test("looks the source installation up when the delivery names none", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockInstallationLookup("pytorch/pytorch", SOURCE_INSTALLATION_ID),
      mockSourceToken(),
      mockComment("pytorch/pytorch"),
    ];

    await receive(
      greenlightEvent({ body: "@greenlight help", installationId: null })
    );

    expect(recorded.calls).toEqual(["installation-lookup", "comment"]);
    handleScope(scopes);
  });

  test("looks the dispatch installation up only once", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch", 31),
      mockReaction("pytorch/pytorch"),
      mockSourceToken(),
      ...mockDispatchToken(false),
      mockDispatch(),
      mockComment("pytorch/pytorch", 32),
      mockReaction("pytorch/pytorch", 890173752),
    ];

    await receive(greenlightEvent());
    await receive(greenlightEvent({ prNumber: 32, commentId: 890173752 }));

    expect(
      recorded.calls.filter((call) => call === "installation-lookup")
    ).toEqual(["installation-lookup"]);
    handleScope(scopes);
  });

  test("the ack says what the bot did without promising a review", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockRemoveLabel("pytorch/pytorch"),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ labels: [{ name: "Stale" }] }));

    expect(recorded.comments).toEqual([
      "Removed the `Stale` label and asked Green Light to take another look.\n\n" +
        "Green Light will re-review this pull request if it has changed since " +
        "its last verdict.",
    ]);
    handleScope(scopes);
  });

  test("leaves the labels alone when the pull request is not Stale", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ labels: [{ name: "triaged" }] }));

    expect(recorded.calls).toEqual([
      "installation-lookup",
      "dispatch",
      "comment",
      "react",
    ]);
    expect(recorded.comments).toEqual([
      "Asked Green Light to take another look.\n\n" +
        "Green Light will re-review this pull request if it has changed since " +
        "its last verdict.",
    ]);
    handleScope(scopes);
  });

  test("carries on when the Stale label is gone before it removes it", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockRemoveLabel("pytorch/pytorch", "Stale", 31, 404),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ labels: [{ name: "Stale" }] }));

    expect(recorded.calls).toEqual([
      "installation-lookup",
      "unlabel-404",
      "dispatch",
      "comment",
      "react",
    ]);
    handleScope(scopes);
  });

  test("dispatches nothing when removing the Stale label fails otherwise", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockRemoveLabel("pytorch/pytorch", "Stale", 31, 500),
    ];

    await receive(greenlightEvent({ labels: [{ name: "Stale" }] }));

    expect(recorded.calls).toEqual(["installation-lookup", "unlabel-500"]);
    expect(recorded.dispatch).toBeUndefined();
    expect(recorded.comments).toEqual([]);
    handleScope(scopes);
  });

  test("reacts confused on a repo that is not allowlisted", async () => {
    process.env.GREENLIGHT_BOT_REPOS = "pytorch/executorch";
    const scopes = [mockSourceToken(), mockReaction("pytorch/pytorch")];

    await receive(greenlightEvent());

    expect(recorded.reactions).toEqual(["confused"]);
    expect(recorded.dispatch).toBeUndefined();
    handleScope(scopes);
  });

  test("fails closed when the allowlist is unset", async () => {
    delete process.env.GREENLIGHT_BOT_REPOS;
    const scopes = [mockSourceToken(), mockReaction("pytorch/pytorch")];

    await receive(greenlightEvent());

    expect(recorded.reactions).toEqual(["confused"]);
    expect(recorded.dispatch).toBeUndefined();
    handleScope(scopes);
  });

  test("ignores an org the bot does not serve, even if allowlisted", async () => {
    process.env.GREENLIGHT_BOT_REPOS = "someoneelse/*";

    await receive(greenlightEvent({ owner: "someoneelse", repo: "repo" }));

    expect(recorded.calls).toEqual([]);
  });

  test("reacts confused when the commenter cannot write", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN, "read"),
      mockSourceToken(),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ labels: [{ name: "Stale" }] }));

    expect(recorded.calls).toEqual(["react"]);
    expect(recorded.reactions).toEqual(["confused"]);
    handleScope(scopes);
  });

  test("refuses a requester the backend would silently drop", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", "ghuser"),
      mockSourceToken(),
      mockComment("pytorch/pytorch"),
    ];

    await receive(
      greenlightEvent({ login: "ghuser", labels: [{ name: "Stale" }] })
    );

    expect(recorded.calls).toEqual(["comment"]);
    expect(recorded.comments[0]).toContain("trusted-requester list");
    expect(recorded.comments[0]).toContain("`ghuser`");
    expect(recorded.dispatch).toBeUndefined();
    handleScope(scopes);
  });

  test("ignores a comment posted by a bot", async () => {
    await receive(greenlightEvent({ login: "greenlight", userType: "Bot" }));
    await receive(greenlightEvent({ login: "pytorch-bot[bot]" }));

    expect(recorded.calls).toEqual([]);
  });

  test("ignores a comment that is not a command", async () => {
    await receive(greenlightEvent({ body: "looks good to me" }));
    await receive(greenlightEvent({ body: "@greenlight" }));
    await receive(greenlightEvent({ body: "cc @greenlight recheck" }));

    expect(recorded.calls).toEqual([]);
  });

  test("ignores a quoted command", async () => {
    await receive(greenlightEvent({ body: "> @greenlight recheck" }));

    expect(recorded.calls).toEqual([]);
  });

  test("ignores a command nobody reading the pull request can see", async () => {
    await receive(greenlightEvent({ body: "```\n@greenlight recheck\n```" }));
    await receive(greenlightEvent({ body: "<!-- @greenlight recheck -->" }));
    await receive(greenlightEvent({ body: "    @greenlight recheck" }));

    expect(recorded.calls).toEqual([]);
  });

  test("ignores a command on an issue", async () => {
    await receive(greenlightEvent({ isPullRequest: false }));

    expect(recorded.calls).toEqual([]);
  });

  test("ignores an edited comment", async () => {
    await receive(greenlightEvent({ action: "edited" }));

    expect(recorded.calls).toEqual([]);
  });

  test("refuses a closed pull request", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      mockComment("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ state: "closed" }));

    expect(recorded.calls).toEqual(["comment"]);
    expect(recorded.comments[0]).toContain("closed");
    expect(recorded.dispatch).toBeUndefined();
    handleScope(scopes);
  });

  test("refuses a merged pull request", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      mockComment("pytorch/pytorch"),
    ];

    await receive(
      greenlightEvent({ state: "closed", mergedAt: "2026-08-01T00:00:00Z" })
    );

    expect(recorded.calls).toEqual(["comment"]);
    expect(recorded.comments[0]).toContain("already merged");
    expect(recorded.dispatch).toBeUndefined();
    handleScope(scopes);
  });

  test("refuses a draft without touching its labels", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      mockComment("pytorch/pytorch"),
    ];

    await receive(
      greenlightEvent({ draft: true, labels: [{ name: "Stale" }] })
    );

    expect(recorded.calls).toEqual(["comment"]);
    expect(recorded.comments[0]).toContain("draft");
    expect(recorded.dispatch).toBeUndefined();
    handleScope(scopes);
  });

  test("reacts confused at an unknown subcommand rather than commenting", async () => {
    const scopes = [mockSourceToken(), mockReaction("pytorch/pytorch")];

    await receive(greenlightEvent({ body: "@greenlight relabel" }));

    expect(recorded.calls).toEqual(["react"]);
    expect(recorded.reactions).toEqual(["confused"]);
    expect(recorded.comments).toEqual([]);
    handleScope(scopes);
  });

  test("never echoes an unknown subcommand back into the pull request", async () => {
    const scopes = [mockSourceToken(), mockReaction("pytorch/pytorch")];

    await receive(greenlightEvent({ body: "@greenlight @pytorch/some-team" }));

    expect(recorded.comments).toEqual([]);
    handleScope(scopes);
  });

  test("answers help with the help text", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      mockComment("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ body: "@greenlight help" }));

    expect(recorded.calls).toEqual(["comment"]);
    expect(recorded.comments[0]).toContain("# Green Light Bot");
    expect(recorded.comments[0]).toContain("| `recheck` |");
    handleScope(scopes);
  });

  test("dispatches once when two deliveries race", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    // Identical deliveries, so which one wins the mark cannot change the mocks
    // the surviving one consumes.
    await Promise.all([receive(greenlightEvent()), receive(greenlightEvent())]);

    expect(recorded.calls).toEqual([
      "installation-lookup",
      "dispatch",
      "comment",
      "react",
    ]);
    handleScope(scopes);
  });

  test("refuses a repo the reviewer workflow cannot review", async () => {
    process.env.GREENLIGHT_BOT_REPOS = "pytorch/executorch";
    const scopes = [
      utils.mockPermissions("pytorch/executorch", TRUSTED_LOGIN),
      mockSourceToken(),
      mockComment("pytorch/executorch"),
    ];

    await receive(greenlightEvent({ repo: "executorch" }));

    expect(recorded.calls).toEqual(["comment"]);
    expect(recorded.comments[0]).toContain("only reviews pytorch/pytorch");
    expect(recorded.dispatch).toBeUndefined();
    handleScope(scopes);
  });

  test("looks the installation up again after the lookup fails", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      mockInstallationLookup(
        "pytorch/test-infra",
        DISPATCH_INSTALLATION_ID,
        500
      ),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent());
    await receive(greenlightEvent());

    expect(recorded.calls).toEqual([
      "installation-lookup-500",
      "installation-lookup",
      "dispatch",
      "comment",
      "react",
    ]);
    handleScope(scopes);
  });

  test("forgets the memoized installation when minting a token fails", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      mockInstallationLookup("pytorch/test-infra", DISPATCH_INSTALLATION_ID),
      mockAccessToken(DISPATCH_INSTALLATION_ID, 500),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent());
    await receive(greenlightEvent());

    // The second lookup is the point: a reinstall changes the id, so a mint
    // failure must not leave the stale one memoized.
    expect(recorded.calls).toEqual([
      "installation-lookup",
      "access-token-500",
      "installation-lookup",
      "dispatch",
      "comment",
      "react",
    ]);
    handleScope(scopes);
  });

  test("reads a mention whatever case it was typed in", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ body: "@GreenLight recheck" }));

    expect(recorded.dispatch).toEqual({
      ref: "main",
      inputs: { pr: "31", requester: TRUSTED_LOGIN },
    });
    handleScope(scopes);
  });

  test("reads the command whatever case it was typed in", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent({ body: "@greenlight RECHECK" }));

    expect(recorded.dispatch).toEqual({
      ref: "main",
      inputs: { pr: "31", requester: TRUSTED_LOGIN },
    });
    handleScope(scopes);
  });

  test("ignores a repeated recheck inside the dedupe window", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent());
    await receive(greenlightEvent({ commentId: 890173752 }));

    expect(recorded.calls).toEqual([
      "installation-lookup",
      "dispatch",
      "comment",
      "react",
    ]);
    handleScope(scopes);
  });

  test("keeps the dedupe window shut when the dispatch fails", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(500),
      mockSourceToken(),
      ...mockDispatchToken(false),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch", 890173752),
    ];

    await receive(greenlightEvent());
    await receive(greenlightEvent({ commentId: 890173752 }));

    expect(recorded.calls).toEqual([
      "installation-lookup",
      "dispatch-500",
      "dispatch",
      "comment",
      "react",
    ]);
    handleScope(scopes);
  });

  test("still dedupes per pull request, not per repo", async () => {
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch", 31),
      mockReaction("pytorch/pytorch"),
      mockSourceToken(),
      ...mockDispatchToken(false),
      mockDispatch(),
      mockComment("pytorch/pytorch", 32),
      mockReaction("pytorch/pytorch", 890173752),
    ];

    await receive(greenlightEvent());
    await receive(greenlightEvent({ prNumber: 32, commentId: 890173752 }));

    expect(recorded.dispatch).toEqual({
      ref: "main",
      inputs: { pr: "32", requester: TRUSTED_LOGIN },
    });
    handleScope(scopes);
  });

  test("dispatches again once the dedupe window has passed", async () => {
    const startedAt = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(startedAt);
    const scopes = [
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      utils.mockPermissions("pytorch/pytorch", TRUSTED_LOGIN),
      mockSourceToken(),
      ...mockDispatchToken(),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
      mockSourceToken(),
      ...mockDispatchToken(false),
      mockDispatch(),
      mockComment("pytorch/pytorch"),
      mockReaction("pytorch/pytorch"),
    ];

    await receive(greenlightEvent());
    now.mockReturnValue(startedAt + RECHECK_DEDUPE_TTL_MS + 1);
    await receive(greenlightEvent());

    expect(recorded.calls).toEqual([
      "installation-lookup",
      "dispatch",
      "comment",
      "react",
      "dispatch",
      "comment",
      "react",
    ]);
    handleScope(scopes);
  });
});
