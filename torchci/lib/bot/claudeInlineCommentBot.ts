import { Probot } from "probot";
import { isPyTorchPyTorch } from "./utils";

// Answers @claude mentions in inline PR review comments.
//
// The @claude workflow (.github/workflows/_claude-code.yml) only listens to
// issue_comment and issues events. pull_request_review_comment is
// intentionally not supported there because that event runs workflow code
// from the PR branch. This bot receives the webhook server-side and dispatches
// a workflow_dispatch workflow on the default branch instead, so the workflow
// definition never comes from the PR. The workflow re-fetches and re-validates
// the comment itself; we only pass identifiers.
//
// If the dispatch fails (e.g. the workflow does not exist yet), we reply in
// the thread so the 👀 reaction the Claude GitHub App adds is not the only
// response.

export const CLAUDE_INLINE_WORKFLOW = "claude-code-inline.yml";

// Matches the author associations the @claude workflow accepts.
const CLAUDE_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export function mentionsClaude(body: string | null | undefined): boolean {
  return /(^|[^\w-])@claude(?![\w-])/i.test(body ?? "");
}

export function formInlineNotice(path: string, line: number | null): string {
  const location = line != null ? `${path}:${line}` : path;
  return (
    "`@claude` could not be started from this inline review comment. " +
    "Please repost your request as a regular comment in the PR conversation, " +
    `mentioning \`${location}\` so Claude knows where to look.`
  );
}

export default function claudeInlineCommentBot(app: Probot): void {
  app.on("pull_request_review_comment.created", async (context) => {
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    if (!isPyTorchPyTorch(owner, repo)) {
      return;
    }
    const comment = context.payload.comment;
    // Replies (ours or Claude's) may mention @claude, so never respond to bots.
    if (comment.user.type === "Bot") {
      return;
    }
    if (!CLAUDE_ALLOWED_ASSOCIATIONS.includes(comment.author_association)) {
      return;
    }
    if (!mentionsClaude(comment.body)) {
      return;
    }
    const prNumber = context.payload.pull_request.number;
    try {
      await context.octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: CLAUDE_INLINE_WORKFLOW,
        ref: context.payload.repository.default_branch,
        inputs: {
          pr_number: String(prNumber),
          comment_id: String(comment.id),
        },
        // workflow_dispatch is not idempotent; a retry could answer twice.
        request: { retries: 0 },
      });
      context.log(
        `Dispatched ${CLAUDE_INLINE_WORKFLOW} for ${comment.html_url}`
      );
    } catch (e: any) {
      context.log.error(
        `Failed to dispatch ${CLAUDE_INLINE_WORKFLOW} for ${comment.html_url}: ${e.message}`
      );
      await context.octokit.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        // Replies must target the top-level comment of the thread.
        comment_id: comment.in_reply_to_id ?? comment.id,
        body: formInlineNotice(comment.path, comment.line ?? null),
      });
    }
  });
}
