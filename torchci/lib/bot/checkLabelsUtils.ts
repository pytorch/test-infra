import { Octokit } from "octokit";

// Comment markers for identifying check-labels comments
export const LABEL_COMMENT_START = "<!-- check-labels-comment-start -->\n";
export const LABEL_COMMENT_END = "\n<!-- check-labels-comment-end -->";

// Bot authors that can create the label error comment
export const BOT_AUTHORS = ["github-actions", "pytorchmergebot", "pytorch-bot"];

// Error message title
export const LABEL_ERR_MSG_TITLE = "This PR needs a `release notes:` label";

// Full error message content
export const LABEL_ERR_MSG = `# ${LABEL_ERR_MSG_TITLE}
If your changes are user facing and intended to be a part of release notes, please use a label starting with \`release notes:\`.

If not, please add the \`topic: not user facing\` label.

To add a label, you can comment to pytorchbot, for example
\`@pytorchbot label "topic: not user facing"\`

For more information, see
https://github.com/pytorch/pytorch/wiki/PyTorch-AutoLabel-Bot#why-categorize-for-release-notes-and-how-does-it-work.
`;

/**
 * Check if the PR has the required labels.
 * A PR is valid if it has either:
 * - A label that starts with "release notes:"
 * - The "topic: not user facing" label
 */
export function hasRequiredLabels(labels: string[]): boolean {
  const hasNotUserFacing = labels.some(
    (l) => l.trim() === "topic: not user facing"
  );
  const hasReleaseNotes = labels.some((l) =>
    l.trim().startsWith("release notes:")
  );
  return hasNotUserFacing || hasReleaseNotes;
}

/**
 * Forms the full label error comment with markers.
 */
export function formLabelErrComment(): string {
  return `${LABEL_COMMENT_START}${LABEL_ERR_MSG}${LABEL_COMMENT_END}`;
}

/**
 * Check if a comment is the label error comment.
 */
export function isLabelErrComment(body: string, author: string): boolean {
  return (
    body.includes(LABEL_COMMENT_START) &&
    BOT_AUTHORS.includes(author.toLowerCase())
  );
}

/**
 * Get the existing label error comment if it exists.
 */
export async function getLabelErrComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNum: number
): Promise<{ id: number; body: string } | null> {
  const commentsRes = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNum,
  });

  for (const comment of commentsRes.data) {
    if (
      comment.body &&
      comment.user &&
      isLabelErrComment(comment.body, comment.user.login)
    ) {
      return { id: comment.id, body: comment.body };
    }
  }
  return null;
}

/**
 * Add the label error comment if it doesn't already exist.
 */
export async function addLabelErrComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNum: number,
  context: any
): Promise<void> {
  const existingComment = await getLabelErrComment(octokit, owner, repo, prNum);

  if (existingComment) {
    context.log(`Label error comment already exists for PR ${prNum}`);
    return;
  }

  const comment = formLabelErrComment();
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNum,
    body: comment,
  });
  context.log(`Added label error comment to PR ${prNum}`);
}

/**
 * Delete the label error comment if it exists.
 */
export async function deleteLabelErrComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNum: number,
  context: any
): Promise<void> {
  const existingComment = await getLabelErrComment(octokit, owner, repo, prNum);

  if (!existingComment) {
    context.log(`No label error comment to delete for PR ${prNum}`);
    return;
  }

  await octokit.rest.issues.deleteComment({
    owner,
    repo,
    comment_id: existingComment.id,
  });
  context.log(`Deleted label error comment from PR ${prNum}`);
}
