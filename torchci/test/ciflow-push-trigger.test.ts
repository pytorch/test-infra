import ciflowPushTrigger from "lib/bot/ciflowPushTrigger";
import * as botUtils from "lib/bot/utils";
import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import {
  mockApprovedWorkflowRuns,
  mockHasApprovedWorkflowRun,
  mockPermissions,
} from "./utils";

nock.disableNetConnect();

function mockListComments(
  repoFullName: string,
  prNum: number,
  comments: any[] = []
) {
  return nock("https://api.github.com")
    .get(`/repos/${repoFullName}/issues/${prNum}/comments?per_page=100`)
    .reply(200, comments);
}

function mockCreateComment(
  repoFullName: string,
  prNum: number,
  bodyContains?: string
) {
  return nock("https://api.github.com")
    .post(`/repos/${repoFullName}/issues/${prNum}/comments`, (body) => {
      if (bodyContains) {
        expect(body.body).toContain(bodyContains);
      }
      return true;
    })
    .reply(200, { id: 1 });
}

function mockUpdateComment(
  repoFullName: string,
  commentId: number,
  bodyContains?: string
) {
  return nock("https://api.github.com")
    .patch(`/repos/${repoFullName}/issues/comments/${commentId}`, (body) => {
      if (bodyContains) {
        expect(body.body).toContain(bodyContains);
      }
      return true;
    })
    .reply(200);
}

describe("Push trigger integration tests", () => {
  let probot: Probot;
  beforeEach(() => {
    probot = new Probot({
      githubToken: "test",
      // Disable throttling & retrying requests for easier testing
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
    ciflowPushTrigger(probot);
  });

  afterEach(() => {
    const pendingMocks = nock.pendingMocks();
    if (pendingMocks.length > 0) {
      console.error("pending mocks: %j", nock.pendingMocks());
    }
    expect(nock.isDone()).toBe(true);
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("CIFlow label trigger ignores closed PR", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "closed";
    payload.label.name = "ciflow/test";

    // no requests should be made
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("CIFlow label triggers tag push to head sha", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "open";
    payload.label.name = "ciflow/trunk";
    const label = payload.label.name;
    const prNum = payload.pull_request.number;

    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/trunk" ]}')
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [])
      .get("/repos/suo/actions-test/collaborators/suo/permission")
      .reply(200, { permission: "admin" });

    nock("https://api.github.com")
      .post("/repos/suo/actions-test/git/refs", (body) => {
        expect(body).toMatchObject({
          ref: `refs/tags/${label}/${prNum}`,
          sha: payload.pull_request.head.sha,
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("non-CIFlow label issues no requests", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    // Change the label to something irrelevant
    payload.label.name = "skipped";

    // No requests should be made.
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("already existing tag should cause tag delete and re-push", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.label.name = "ciflow/trunk";
    const label = payload.label.name;
    const prNum = payload.pull_request.number;

    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/trunk" ]}')
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [
        {
          ref: `refs/tags/${label}/${prNum}`,
          node_id: "123",
          object: { sha: "abc" },
        },
      ])
      .get("/repos/suo/actions-test/collaborators/suo/permission")
      .reply(200, { permission: "admin" });

    nock("https://api.github.com")
      .delete(
        `/repos/suo/actions-test/git/refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200);

    nock("https://api.github.com")
      .post("/repos/suo/actions-test/git/refs", (body) => {
        expect(body).toMatchObject({
          ref: `refs/tags/${label}/${prNum}`,
          sha: payload.pull_request.head.sha,
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("unlabel of CIFlow label should cause tag deletion", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.unlabeled");
    payload.label.name = "ciflow/trunk";

    const label = payload.label.name;
    const prNum = payload.pull_request.number;

    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [
        {
          ref: `refs/tags/${label}/${prNum}`,
          node_id: "123",
          object: { sha: "abc" },
        },
      ]);

    nock("https://api.github.com")
      .delete(
        `/repos/suo/actions-test/git/refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("unlabel of non-CIFlow label should do nothing", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.unlabeled");
    payload.label.name = "foobar";

    // no API requests should be made
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("synchronization of PR should cause all tags to update", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.synchronize");
    const prNum = payload.pull_request.number;
    const labels = [
      "ciflow/test",
      /* payload has "unrelated" label which should be skipped */
      "ciflow/1",
    ];

    mockHasApprovedWorkflowRun(payload.repository.full_name);

    for (const label of labels) {
      nock("https://api.github.com")
        .get(
          `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200, [
          {
            ref: `refs/tags/${label}/${prNum}`,
            node_id: "123",
            object: { sha: "abc" },
          },
        ]);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .delete(
          `/repos/suo/actions-test/git/refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .post("/repos/suo/actions-test/git/refs", (body) => {
          expect(body).toMatchObject({
            ref: `refs/tags/${label}/${prNum}`,
            sha: payload.pull_request.head.sha,
          });
          return true;
        })
        .reply(200);
    }

    // After syncing tags, should check for pending comment to resolve
    mockListComments("suo/actions-test", prNum);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("synchronization of PR without permissions skips tag sync but keeps labels", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.synchronize");
    mockApprovedWorkflowRuns(
      payload.repository.full_name,
      payload.pull_request.head.sha,
      false
    );
    mockPermissions(
      payload.repository.full_name,
      payload.pull_request.user.login,
      "read"
    );
    // No label removal or tag creation should happen -- labels are kept,
    // tags are simply not created until workflows are approved.
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("closure of PR should cause all tags to be removed", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.closed");
    const prNum = payload.pull_request.number;
    const labels = [
      "ciflow/test",
      /* payload has "unrelated" label which should be skipped */
      "ciflow/1",
    ];
    for (const label of labels) {
      nock("https://api.github.com")
        .get(
          `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200, [
          {
            ref: `refs/tags/${label}/${prNum}`,
            node_id: "123",
            object: { sha: "abc" },
          },
        ]);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .delete(
          `/repos/suo/actions-test/git/refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200);
    }
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("Unconfigured CIFlow label does nothing", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "open";

    payload.label.name = "ciflow/test";
    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(404, { message: "There is nothing here" });
    nock("https://api.github.com")
      .get(
        `/repos/suo/.github/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(404, { message: "There is nothing here" });
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("sync event with approval resolves pending comment", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.synchronize");
    const prNum = payload.pull_request.number;
    const labels = ["ciflow/test", "ciflow/1"];

    mockHasApprovedWorkflowRun(payload.repository.full_name);

    for (const label of labels) {
      nock("https://api.github.com")
        .get(
          `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200, [
          {
            ref: `refs/tags/${label}/${prNum}`,
            node_id: "123",
            object: { sha: "abc" },
          },
        ]);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .delete(
          `/repos/suo/actions-test/git/refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .post("/repos/suo/actions-test/git/refs", (body) => {
          expect(body).toMatchObject({
            ref: `refs/tags/${label}/${prNum}`,
            sha: payload.pull_request.head.sha,
          });
          return true;
        })
        .reply(200);
    }

    // Should look for and resolve pending comment
    const pendingCommentId = 42;
    mockListComments("suo/actions-test", prNum, [
      {
        id: pendingCommentId,
        body: "<!-- ciflow-pending -->\nWorkflows awaiting approval",
      },
    ]);
    mockUpdateComment(
      "suo/actions-test",
      pendingCommentId,
      "CI has now been triggered"
    );

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("Invalid CIFlow label with established contributor triggers flow", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    const permission = require("./fixtures/push-trigger/permission");
    const label = payload.label.name;
    const prNum = payload.pull_request.number;
    payload.pull_request.state = "open";
    payload.label.name = "ciflow/test";
    nock("https://api.github.com")
      .get(`/repos/suo/actions-test/collaborators/suo/permission`)
      .reply(200, permission) // note: example response from pytorch not action-test
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/foo" ]}')
      .post("/repos/suo/actions-test/issues/5/comments", (body) => {
        expect(body.body).toContain("Unknown label `ciflow/test`.");
        return true;
      })
      .reply(200)
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [])
      .post("/repos/suo/actions-test/git/refs", (body) => {
        expect(body).toMatchObject({
          ref: `refs/tags/${label}/${prNum}`,
          sha: payload.pull_request.head.sha,
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("Invalid CIFlow label with first time contributor creates comment", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "open";
    payload.label.name = "ciflow/test";
    payload.pull_request.user.login = "fake_user";
    const login = payload.pull_request.user.login;
    const head_sha = payload.pull_request.head.sha;
    nock("https://api.github.com")
      .get(`/repos/suo/actions-test/actions/runs?head_sha=${head_sha}`)
      .reply(200, {})
      .get(`/repos/suo/actions-test/collaborators/${login}/permission`)
      .reply(200, {
        message: "fake_user is not a user",
        documentation_url:
          "https://docs.github.com/rest/collaborators/collaborators#get-repository-permissions-for-a-user",
      })
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/foo" ]}')
      .post("/repos/suo/actions-test/issues/5/comments", (body) => {
        expect(body.body).toContain("Unknown label `ciflow/test`.");
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("CIFlow label without approval keeps label and posts pending comment", async () => {
    // Deep-clone fixture to avoid mutating the cached require() result
    const payload = JSON.parse(
      JSON.stringify(require("./fixtures/push-trigger/pull_request.labeled"))
    );
    payload.pull_request.state = "open";
    payload.label.name = "ciflow/trunk";
    payload.pull_request.user.login = "new_contributor";
    const prNum = payload.pull_request.number;
    const head_sha = payload.pull_request.head.sha;
    const login = payload.pull_request.user.login;

    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/trunk" ]}');

    mockPermissions("suo/actions-test", login, "read");

    mockApprovedWorkflowRuns("suo/actions-test", head_sha, false);

    // Should search for existing pending comment
    mockListComments("suo/actions-test", prNum);

    // Should post a NEW pending comment (not remove the label)
    mockCreateComment("suo/actions-test", prNum, "awaiting approval");

    // No tag creation or label removal should happen
    await probot.receive({ name: "pull_request", id: "123", payload });
  });
});
