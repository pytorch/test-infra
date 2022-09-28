export async function reactOnComment(ctx: any, reaction: "+1" | "confused") {
  ctx.log(
    `Reacting with "${reaction}" to comment ${ctx.payload.comment.html_url}`
  );
  await ctx.octokit.reactions.createForIssueComment({
    comment_id: ctx.payload.comment.id,
    content: reaction,
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
  });
}

export async function addComment(ctx: any, message: string) {
  ctx.log(
    `Commenting with "${message}" on issue ${ctx.payload.issue.html_url}`
  );
  await ctx.octokit.issues.createComment({
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    issue_number: ctx.payload.issue.number,
    body: message,
  });
}

export async function addLabels(ctx: any, labelsToAdd: string[]) {
  if (ctx.payload.issue) {
    ctx.log(
      `Adding label(s) ${labelsToAdd} to issue ${ctx.payload.issue.html_url}`
    );
  }
  if (ctx.payload.pull_request) {
    ctx.log(
      `Adding label(s) ${labelsToAdd} to pull request ${ctx.payload.pull_request.html_url}`
    );
  }
  await ctx.octokit.issues.addLabels(
    ctx.issue({ labels: labelsToAdd })
  );
}

export async function getUserPermissions(ctx: any, username: string): Promise<string> {
  const res = await ctx.octokit.repos.getCollaboratorPermissionLevel({
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    username,
  });
  return res?.data?.permission;
}

export async function hasWritePermissions(ctx: any, username: string): Promise<boolean> {
  const permissions = await getUserPermissions(ctx, username);
  return permissions === "admin" || permissions === "write";
}
