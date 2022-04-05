import ciflowPushTrigger from "lib/bot/ciflowPushTrigger";
import nock from "nock";
import { Probot, ProbotOctokit } from "probot";

nock.disableNetConnect();

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
    ciflowPushTrigger(probot);
  });

  afterEach(() => {
    const pendingMocks = nock.pendingMocks();
    if (pendingMocks.length > 0) {
      console.error("pending mocks: %j", nock.pendingMocks());
    }
    expect(nock.isDone()).toBe(true);
    nock.cleanAll();
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
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, []);

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

  test("old/invalid CIFlow label creates comment", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "open";

    payload.label.name = "ciflow/test";
    nock("https://api.github.com")
      .post("/repos/suo/actions-test/issues/5/comments", (body) => {
        expect(body.body).toContain("We have recently simplified the CIFlow labels and `ciflow/test` is no longer in use.");
        return true;
      })
      .reply(200);
    await probot.receive({ name: "pull_request", id: "123", payload });

    payload.label.name = "ci/test";
    nock("https://api.github.com")
      .post("/repos/suo/actions-test/issues/5/comments", (body) => {
        expect(body.body).toContain("We have recently simplified the CIFlow labels and `ci/test` is no longer in use.");
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });
});
