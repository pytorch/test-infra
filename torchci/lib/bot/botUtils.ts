export async function reactOnComment(ctx: any, reaction: "+1" | "confused") {
  await ctx.octokit.reactions.createForIssueComment({
    comment_id: ctx.payload.comment.id,
    content: reaction,
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
  });
}

export async function addComment(ctx: any, message: string) {
  await ctx.octokit.issues.createComment({
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    issue_number: ctx.payload.issue.number,
    body: message,
  });
}

export async function addLabels(ctx: any, labelsToAdd: string[]) {
  await ctx.octokit.issues.addLabels({
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    issue_number: ctx.payload.issue.number,
    labels: labelsToAdd,
  });
}
