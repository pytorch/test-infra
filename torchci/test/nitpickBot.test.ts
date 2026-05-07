import nitpickBot, {
  fileMatchesRule,
  formNitpickComment,
  getMatchingRules,
  NITPICK_COMMENT_START,
  parseNitpickConfig,
} from "lib/bot/nitpickBot";
import nock from "nock";
import { Probot } from "probot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const PYTORCH_REPO = "pytorch/pytorch";

function mockNitpickConfig(content: string | null) {
  const path = encodeURIComponent(".github/nitpick.yml");
  if (content === null) {
    return nock("https://api.github.com")
      .get(`/repos/${PYTORCH_REPO}/contents/${path}`)
      .reply(404);
  }
  return nock("https://api.github.com")
    .get(`/repos/${PYTORCH_REPO}/contents/${path}`)
    .reply(200, {
      type: "file",
      path: ".github/nitpick.yml",
      name: "nitpick.yml",
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
    });
}

function mockChangedFiles(prNumber: number, files: string[]) {
  return nock("https://api.github.com")
    .get(`/repos/${PYTORCH_REPO}/pulls/${prNumber}/files?per_page=100`)
    .reply(
      200,
      files.map((f) => ({ filename: f }))
    );
}

function mockListComments(
  prNumber: number,
  comments: { id: number; body: string }[]
) {
  return nock("https://api.github.com")
    .get(`/repos/${PYTORCH_REPO}/issues/${prNumber}/comments`)
    .reply(200, comments);
}

function makePrEvent(
  action: "opened" | "synchronize" | "reopened",
  prNumber = 31
) {
  const payload = requireDeepCopy("./fixtures/pull_request.opened.json");
  payload.payload.action = action;
  payload.payload.pull_request.number = prNumber;
  payload.payload.pull_request.state = "open";
  payload.payload.number = prNumber;
  payload.payload.repository.owner.login = "pytorch";
  payload.payload.repository.name = "pytorch";
  payload.payload.repository.full_name = "pytorch/pytorch";
  return payload;
}

describe("nitpickBot pure helpers", () => {
  describe("parseNitpickConfig", () => {
    test("parses a list of rules", () => {
      const yaml = `- markdown: |
    Hello
  pathFilter:
    - "+src/**"
    - "-src/**/*.test.ts"
- markdown: |
    World
  pathFilter:
    - docs/**
`;
      const rules = parseNitpickConfig(yaml);
      expect(rules).toHaveLength(2);
      expect(rules[0].markdown).toContain("Hello");
      expect(rules[0].pathFilter).toEqual(["+src/**", "-src/**/*.test.ts"]);
      expect(rules[1].pathFilter).toEqual(["docs/**"]);
    });

    test("ignores entries without markdown or pathFilter", () => {
      const yaml = `- markdown: ok
  pathFilter:
    - foo
- markdown: missing-filter
- pathFilter:
    - bar`;
      const rules = parseNitpickConfig(yaml);
      expect(rules).toHaveLength(1);
    });

    test("returns empty array for non-list YAML", () => {
      expect(parseNitpickConfig("foo: bar")).toEqual([]);
      expect(parseNitpickConfig("")).toEqual([]);
    });
  });

  describe("fileMatchesRule", () => {
    const rule = {
      markdown: "x",
      pathFilter: ["+src/**", "-src/**/*.test.ts"],
    };

    test("matches included file", () => {
      expect(fileMatchesRule("src/foo.ts", rule)).toBe(true);
    });

    test("rejects excluded file", () => {
      expect(fileMatchesRule("src/foo.test.ts", rule)).toBe(false);
    });

    test("rejects non-included file", () => {
      expect(fileMatchesRule("docs/readme.md", rule)).toBe(false);
    });

    test("treats unprefixed pattern as include", () => {
      expect(
        fileMatchesRule("docs/x.md", {
          markdown: "x",
          pathFilter: ["docs/**"],
        })
      ).toBe(true);
    });
  });

  describe("getMatchingRules", () => {
    test("returns rules with at least one matching file", () => {
      const rules = [
        { markdown: "A", pathFilter: ["+src/**"] },
        { markdown: "B", pathFilter: ["+docs/**"] },
      ];
      expect(getMatchingRules(["src/foo.ts", "README.md"], rules)).toHaveLength(
        1
      );
      expect(getMatchingRules(["src/foo.ts", "docs/x.md"], rules)).toHaveLength(
        2
      );
      expect(getMatchingRules(["README.md"], rules)).toHaveLength(0);
    });
  });

  describe("formNitpickComment", () => {
    test("empty when no rules", () => {
      expect(formNitpickComment([])).toBe("");
    });

    test("wraps body in start/end markers and joins rules", () => {
      const body = formNitpickComment([
        { markdown: "  hello  ", pathFilter: [] },
        { markdown: "world", pathFilter: [] },
      ]);
      expect(body).toContain(NITPICK_COMMENT_START);
      expect(body).toContain("hello");
      expect(body).toContain("world");
      expect(body).toMatch(/hello[\s\S]*---[\s\S]*world/);
    });
  });
});

describe("nitpickBot probot integration", () => {
  let probot: Probot;
  const NITPICK_YAML = `- markdown: |
    ## Did you update the docs?
    Please update docs when changing the public API.
  pathFilter:
    - "+torch/**"
    - "-torch/**/*.test.py"
`;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(nitpickBot);
    utils.mockAccessToken();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("posts a new comment when a rule matches", async () => {
    const event = makePrEvent("opened", 100);
    const scopes = [
      mockNitpickConfig(NITPICK_YAML),
      mockChangedFiles(100, ["torch/foo.py"]),
      mockListComments(100, []),
      utils.mockPostComment(PYTORCH_REPO, 100, [
        NITPICK_COMMENT_START,
        "Did you update the docs",
      ]),
    ];

    await probot.receive(event);
    handleScope(scopes);
  });

  test("does not post when no files match", async () => {
    const event = makePrEvent("opened", 101);
    const scopes = [
      mockNitpickConfig(NITPICK_YAML),
      mockChangedFiles(101, ["docs/readme.md"]),
      mockListComments(101, []),
    ];

    await probot.receive(event);
    handleScope(scopes);
  });

  test("excluded paths suppress matches", async () => {
    const event = makePrEvent("synchronize", 102);
    const scopes = [
      mockNitpickConfig(NITPICK_YAML),
      mockChangedFiles(102, ["torch/dir/x.test.py"]),
      mockListComments(102, []),
    ];

    await probot.receive(event);
    handleScope(scopes);
  });

  test("updates existing nitpick comment", async () => {
    const event = makePrEvent("synchronize", 103);
    const scopes = [
      mockNitpickConfig(NITPICK_YAML),
      mockChangedFiles(103, ["torch/foo.py"]),
      mockListComments(103, [
        { id: 555, body: `${NITPICK_COMMENT_START}\nold body\n` },
      ]),
      nock("https://api.github.com")
        .patch(`/repos/${PYTORCH_REPO}/issues/comments/555`, (body) => {
          expect(body.body).toContain("Did you update the docs");
          return true;
        })
        .reply(200, {}),
    ];

    await probot.receive(event);
    handleScope(scopes);
  });

  test("deletes stale comment when nothing matches anymore", async () => {
    const event = makePrEvent("synchronize", 104);
    const scopes = [
      mockNitpickConfig(NITPICK_YAML),
      mockChangedFiles(104, ["docs/readme.md"]),
      mockListComments(104, [
        { id: 777, body: `${NITPICK_COMMENT_START}\nold body\n` },
      ]),
      nock("https://api.github.com")
        .delete(`/repos/${PYTORCH_REPO}/issues/comments/777`)
        .reply(204),
    ];

    await probot.receive(event);
    handleScope(scopes);
  });

  test("skips when no nitpick.yml present", async () => {
    const event = makePrEvent("opened", 105);
    const scope = mockNitpickConfig(null);

    await probot.receive(event);
    handleScope(scope);
  });

  test("skips when repo is not pytorch/pytorch", async () => {
    const event = makePrEvent("opened", 106);
    event.payload.repository.owner.login = "zhouzhuojie";
    event.payload.repository.name = "gha-ci-playground";
    event.payload.repository.full_name = "zhouzhuojie/gha-ci-playground";

    await probot.receive(event);
    // No nock mocks are set up; if any HTTP call were made, the test
    // would fail because nock.disableNetConnect() is on.
  });
});
