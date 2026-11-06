import * as mergeCiflowLabels from "lib/bot/mergeCiflowLabels";
import { addCiflowLabelsAtMerge } from "lib/bot/mergeCiflowLabels";
import nock from "nock";
import * as probot from "probot";
import pytorchBot from "../lib/bot/pytorchBot";
import * as clickhouse from "../lib/clickhouse";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const owner = "pytorch";
const repo = "pytorch";
const LABELER = {
  "ciflow/trunk": [".ci/docker/ci_commit_pins/triton.txt"],
  "ciflow/inductor": ["torch/_inductor/**"],
  "ciflow/xpu": ["torch/xpu/**"],
  "ciflow/docker": [".ci/docker/**"],
};
const INDUCTOR = "torch/_inductor/a.py";
const XPU = "torch/xpu/a.py";
const DOCKER = ".ci/docker/a.sh";
const TRITON_PIN = ".ci/docker/ci_commit_pins/triton.txt";

type Pr = { number: number; files: string[]; labels?: string[] };

function stackBody(top: number, merged: number, below: number[]): string {
  const rows = [];
  for (let n = top; n > merged; n--) {
    rows.push(`* #${n}`);
  }
  rows.push(`* __->__ #${merged}`, ...below.map((n) => `* #${n}`));
  return ["Stack from [ghstack](https://github.com/ezyang/ghstack):", ...rows]
    .concat(["", "Summary."])
    .join("\n");
}

function prNode(pr: Pr) {
  return {
    number: pr.number,
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    headRefName: `gh/alice/${pr.number}/head`,
    labels: { nodes: (pr.labels ?? []).map((name) => ({ name })) },
    changedFiles: pr.files.length,
    files: { nodes: pr.files.map((path) => ({ path })) },
  };
}

// The reads addCiflowLabelsAtMerge makes for the merged PR, with the PRs below
// it nearest first; an empty list is a PR outside any stack, "fail" a ghstack
// whose stack read fails.
function mockReads(
  scope: nock.Scope,
  merged: Pr,
  below: Pr[] | "fail",
  top: number = merged.number
) {
  const stacked = below === "fail" || below.length > 0;
  scope
    .get(`/repos/${owner}/${repo}/pulls/${merged.number}`)
    .reply(200, {
      number: merged.number,
      draft: false,
      body: stacked
        ? stackBody(
            top,
            merged.number,
            below === "fail" ? [merged.number - 1] : below.map((p) => p.number)
          )
        : "Summary.",
      labels: (merged.labels ?? []).map((name) => ({ name })),
      head: {
        ref: stacked ? `gh/alice/${merged.number}/head` : "feature",
        repo: { full_name: `${owner}/${repo}` },
      },
      base: { repo: { full_name: `${owner}/${repo}` } },
    })
    .get(`/repos/${owner}/${repo}/pulls/${merged.number}/files?per_page=100`)
    .reply(
      200,
      merged.files.map((filename) => ({ filename }))
    );
  if (below === "fail") {
    scope.post("/graphql").reply(500, { message: "boom" });
  } else if (below.length) {
    const nodes: any = {};
    below.forEach((pr, i) => {
      nodes[`pr${i}`] = prNode(pr);
    });
    scope
      .post("/graphql", (body) => body.query.includes("StackPrFields"))
      .reply(200, { data: { repository: nodes } });
  }
  return scope;
}

function expectAddLabels(scope: nock.Scope, number: number, labels: string[]) {
  scope
    .post(`/repos/${owner}/${repo}/issues/${number}/labels`, (body) => {
      expect(body).toEqual({ labels });
      return true;
    })
    .reply(200, {});
}

describe("addCiflowLabelsAtMerge", () => {
  const octokit = utils.testOctokit();
  const log = Object.assign(jest.fn(), { error: jest.fn() });

  afterEach(() => {
    nock.cleanAll();
    log.mockReset();
    log.error.mockReset();
  });

  const run = (merged: Pr, below: Pr[], top?: number) =>
    mockReads(nock("https://api.github.com"), merged, below, top);

  const label = (
    prNumber: number,
    addedLabels: string[] = [],
    config: object = LABELER
  ) =>
    addCiflowLabelsAtMerge({
      octokit,
      owner,
      repo,
      prNumber,
      addedLabels,
      loadLabelerConfig: async () => config,
      log,
    });

  test("adds each label to the topmost PR at or below the merged one that needs it", async () => {
    // Stack 8..1: 6 needs xpu (labeled), 4 needs xpu, 3 needs inductor
    // (labeled), 2 needs both. Merging 5 labels only PR 4, with ciflow/xpu.
    const scope = run(
      { number: 5, files: ["torch/a.py"] },
      [
        { number: 4, files: [XPU] },
        { number: 3, files: [INDUCTOR], labels: ["ciflow/inductor"] },
        { number: 2, files: [INDUCTOR, XPU] },
        { number: 1, files: ["torch/b.py"] },
      ],
      8
    );
    expectAddLabels(scope, 4, ["ciflow/xpu"]);
    await label(5);
    expect(log.error).not.toHaveBeenCalled();
    handleScope(scope);
  });

  test("labels the merged PR when it needs a label it lacks", async () => {
    const scope = run({ number: 5, files: [INDUCTOR] }, [
      { number: 4, files: [INDUCTOR, XPU] },
    ]);
    expectAddLabels(scope, 5, ["ciflow/inductor"]);
    expectAddLabels(scope, 4, ["ciflow/xpu"]);
    await label(5);
    expect(log.error).not.toHaveBeenCalled();
    handleScope(scope);
  });

  test("adds nothing when the topmost needing PR already carries the label", async () => {
    const scope = run(
      { number: 5, files: [INDUCTOR], labels: ["ciflow/inductor"] },
      [{ number: 4, files: [INDUCTOR, XPU], labels: ["ciflow/xpu"] }]
    );
    await label(5);
    expect(log.error).not.toHaveBeenCalled();
    handleScope(scope);
  });

  test("counts the labels the merge just added as carried", async () => {
    const scope = run({ number: 5, files: [XPU] }, []);
    await label(5, ["ciflow/xpu"]);
    expect(log.error).not.toHaveBeenCalled();
    handleScope(scope);
  });

  test("adds nothing when a PR above the topmost needing PR carries the label", async () => {
    const scope = run({ number: 5, files: ["torch/a.py"] }, [
      { number: 4, files: [TRITON_PIN] },
    ]);
    await label(5, ["ciflow/trunk"]);
    expect(log.error).not.toHaveBeenCalled();
    handleScope(scope);
  });

  test("a failed addLabels on one PR is logged and the others are still labeled", async () => {
    const scope = run({ number: 5, files: [INDUCTOR] }, [
      { number: 4, files: [XPU] },
    ]);
    scope
      .post(`/repos/${owner}/${repo}/issues/5/labels`)
      .reply(500, { message: "boom" });
    expectAddLabels(scope, 4, ["ciflow/xpu"]);
    await label(5);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatchObject({
      labeledPr: 5,
      labels: ["ciflow/inductor"],
    });
    handleScope(scope);
  });

  test("never adds ciflow/docker", async () => {
    const scope = run({ number: 5, files: [DOCKER] }, [
      { number: 4, files: [DOCKER] },
    ]);
    await label(5);
    expect(log.error).not.toHaveBeenCalled();
    handleScope(scope);
  });
});

describe("merge command: ciflow labels at merge", () => {
  let bot: probot.Probot;

  beforeEach(() => {
    bot = utils.testProbot();
    bot.load(pytorchBot);
    jest
      .spyOn(clickhouse, "queryClickhouseSaved")
      .mockImplementation(() => Promise.resolve([{ workflow_name: "pull" }]));
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  function mergeEvent(body: string) {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = body;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;
    return event;
  }

  function expectDispatch(scope: nock.Scope, event: any, force: boolean) {
    const forced = force ? `,"force":true` : "";
    scope
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${event.payload.issue.number},"comment_id":${event.payload.comment.id}${forced}}}`
        );
        return true;
      })
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/issues/comments/${event.payload.comment.id}/reactions`
      )
      .reply(200, {});
  }

  test("a force merge adds no ciflow labels", async () => {
    const spy = jest.spyOn(mergeCiflowLabels, "addCiflowLabelsAtMerge");
    const event = mergeEvent("@pytorchbot merge -f '[MINOR] Fix lint'");
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, "mergebot: True\nlabeler_config: labeler.yml\n")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "write" });
    expectDispatch(scope, event, true);
    await bot.receive(event);
    handleScope(scope);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a failed stack read still dispatches the merge", async () => {
    const event = mergeEvent("@pytorchbot merge");
    const prNumber = event.payload.issue.number;
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, "mergebot: True\nlabeler_config: labeler.yml\n")
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/labeler.yml"
        )}`
      )
      .reply(200, JSON.stringify(LABELER))
      .get(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`)
      .reply(200, requireDeepCopy("./fixtures/pull_request_reviews.json"))
      .post(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, (body) => {
        expect(body).toEqual({ labels: ["ciflow/trunk"] });
        return true;
      })
      .reply(200, {});
    utils.mockGetPR(`${owner}/${repo}`, prNumber, { head: { sha: "sha" } });
    mockReads(scope, { number: prNumber, files: [XPU] }, "fail");
    expectDispatch(scope, event, false);
    const permissions = utils.mockPermissions(
      `${owner}/${repo}`,
      event.payload.issue.user.login,
      "write"
    );
    await bot.receive(event);
    handleScope(scope);
    handleScope(permissions);
  });
});
