import { Probot } from "probot";
import { isPyTorchPyTorch } from "./utils";

// The @claude workflow (.github/workflows/_claude-code.yml) only listens to
// issue_comment and issues events. pull_request_review_comment is
// intentionally not supported because that event runs workflow code from the
// PR branch. However, the Claude GitHub App still reacts with 👀 to @claude
// mentions in inline review comments, which makes it look like a job was
// started when nothing will ever answer. This bot replies in the review
// thread to tell the commenter to repost on the PR conversation instead.
// It runs server-side, so it does not have the PR-branch code execution
// problem a workflow would.

// Matches the author associations the @claude workflow accepts; anyone else
// would not get a response from a top-level comment either.
const CLAUDE_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export function mentionsClaude(body: string | null | undefined): boolean {
  return /(^|[^\w-])@claude(?![\w-])/i.test(body ?? "");
}

export function formInlineNotice(path: string, line: number | null): string {
  const location = line != null ? `${path}:${line}` : path;
  return (
    "`@claude` does not respond to inline review comments. The 👀 reaction " +
    "comes from the Claude GitHub App and does not mean a job was started. " +
    "Please repost your request as a regular comment in the PR conversation, " +
    `mentioning \`${location}\` so Claude knows where to look.`
  );
}

export default function claudeInlineNoticeBot(app: Probot): void {
  app.on("pull_request_review_comment.created", async (context) => {
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    if (!isPyTorchPyTorch(owner, repo)) {
      return;
    }
    const comment = context.payload.comment;
    // Our own reply mentions @claude, so never respond to bots.
    if (comment.user.type === "Bot") {
      return;
    }
    if (!CLAUDE_ALLOWED_ASSOCIATIONS.includes(comment.author_association)) {
      return;
    }
    if (!mentionsClaude(comment.body)) {
      return;
    }
    context.log(`Replying to inline @claude mention ${comment.html_url}`);
    await context.octokit.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: context.payload.pull_request.number,
      // Replies must target the top-level comment of the thread.
      comment_id: comment.in_reply_to_id ?? comment.id,
      body: formInlineNotice(comment.path, comment.line ?? null),
    });
  });
}
