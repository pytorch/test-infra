import claudeInlineCommentBot, {
  CLAUDE_INLINE_WORKFLOW,
  formInlineNotice,
  mentionsClaude,
} from "lib/bot/claudeInlineCommentBot";
import nock from "nock";
import { Probot } from "probot";
import { handleScope } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const PYTORCH_REPO = "pytorch/pytorch";

function makeReviewCommentEvent(
  overrides: {
    body?: string;
    owner?: string;
    repo?: string;
    userType?: string;
    association?: string;
    commentId?: number;
    inReplyToId?: number;
    line?: number | null;
  } = {}
) {
  const owner = overrides.owner ?? "pytorch";
  const repo = overrides.repo ?? "pytorch";
  return {
    name: "pull_request_review_comment",
    id: "123",
    payload: {
      action: "created",
      comment: {
        id: overrides.commentId ?? 4196187570,
        in_reply_to_id: overrides.inReplyToId,
        body: overrides.body ?? "@claude what does this sentence mean?",
        path: "torch/cuda/memory.py",
        line: overrides.line === undefined ? 664 : overrides.line,
        html_url: `https://github.com/${owner}/${repo}/pull/199076#discussion_r4196187570`,
        author_association: overrides.association ?? "MEMBER",
        user: { login: "ezyang", type: overrides.userType ?? "User" },
      },
      pull_request: { number: 199076 },
      repository: {
        name: repo,
        full_name: `${owner}/${repo}`,
        owner: { login: owner },
        default_branch: "main",
      },
      installation: { id: 2 },
    },
  };
}

function mockDispatch(commentId: number, status = 204) {
  return nock("https://api.github.com")
    .post(
      `/repos/${PYTORCH_REPO}/actions/workflows/${CLAUDE_INLINE_WORKFLOW}/dispatches`,
      (body) => {
        expect(body).toEqual({
          ref: "main",
          inputs: { pr_number: "199076", comment_id: String(commentId) },
        });
        return true;
      }
    )
    .reply(status);
}

function mockReply(topLevelCommentId: number, containedStrings: string[]) {
  return nock("https://api.github.com")
    .post(
      `/repos/${PYTORCH_REPO}/pulls/199076/comments/${topLevelCommentId}/replies`,
      (body) => {
        for (const s of containedStrings) {
          expect(body.body).toContain(s);
        }
        return true;
      }
    )
    .reply(201);
}

describe("claudeInlineCommentBot pure helpers", () => {
  test("mentionsClaude", () => {
    expect(mentionsClaude("@claude review")).toBe(true);
    expect(mentionsClaude("hey @Claude, why?")).toBe(true);
    expect(mentionsClaude("cc @claude")).toBe(true);
    expect(mentionsClaude("claude review")).toBe(false);
    expect(mentionsClaude("@claudebot review")).toBe(false);
    expect(mentionsClaude("@claude-bot review")).toBe(false);
    expect(mentionsClaude("foo@claude.ai")).toBe(false);
    expect(mentionsClaude(null)).toBe(false);
  });

  test("formInlineNotice includes location", () => {
    expect(formInlineNotice("a/b.py", 12)).toContain("`a/b.py:12`");
    expect(formInlineNotice("a/b.py", null)).toContain("`a/b.py`");
  });
});

describe("claudeInlineCommentBot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(claudeInlineCommentBot);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test("dispatches the workflow for an inline @claude mention", async () => {
    utils.mockAccessToken();
    const scope = mockDispatch(4196187570);
    await probot.receive(makeReviewCommentEvent() as any);
    handleScope(scope);
  });

  test("passes the reply's own id, not the thread root", async () => {
    utils.mockAccessToken();
    const scope = mockDispatch(222);
    await probot.receive(
      makeReviewCommentEvent({ commentId: 222, inReplyToId: 111 }) as any
    );
    handleScope(scope);
  });

  test("replies with a notice when the dispatch fails", async () => {
    utils.mockAccessToken();
    const scopes = [
      mockDispatch(4196187570, 404),
      mockReply(4196187570, [
        "could not be started",
        "`torch/cuda/memory.py:664`",
      ]),
    ];
    await probot.receive(makeReviewCommentEvent() as any);
    handleScope(scopes);
  });

  test("notice replies to the top-level comment of a thread", async () => {
    utils.mockAccessToken();
    const scopes = [
      mockDispatch(222, 404),
      mockReply(111, ["PR conversation"]),
    ];
    await probot.receive(
      makeReviewCommentEvent({ commentId: 222, inReplyToId: 111 }) as any
    );
    handleScope(scopes);
  });

  test.each([
    ["no mention", { body: "looks good" }],
    ["bot author", { userType: "Bot" }],
    ["non-member", { association: "CONTRIBUTOR" }],
    ["other repo", { repo: "vision" }],
  ])("ignores %s", async (_name, overrides) => {
    // No mocks are registered and nock.disableNetConnect() is on, so any
    // GitHub request (even fetching an installation token) would throw.
    await probot.receive(makeReviewCommentEvent(overrides) as any);
  });
});
