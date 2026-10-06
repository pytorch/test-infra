import claudeInlineNoticeBot, {
  formInlineNotice,
  mentionsClaude,
} from "lib/bot/claudeInlineNoticeBot";
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
      },
      installation: { id: 2 },
    },
  };
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

describe("claudeInlineNoticeBot pure helpers", () => {
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

describe("claudeInlineNoticeBot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(claudeInlineNoticeBot);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test("replies to inline @claude mention from a member", async () => {
    utils.mockAccessToken();
    const scope = mockReply(4196187570, [
      "does not respond to inline review comments",
      "`torch/cuda/memory.py:664`",
    ]);
    await probot.receive(makeReviewCommentEvent() as any);
    handleScope(scope);
  });

  test("replies to the top-level comment of a thread", async () => {
    utils.mockAccessToken();
    const scope = mockReply(111, ["PR conversation"]);
    await probot.receive(
      makeReviewCommentEvent({ commentId: 222, inReplyToId: 111 }) as any
    );
    handleScope(scope);
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
