import { Probot } from "probot";
import { reactOnComment } from "./botUtils";

export default function pingBot(app: Probot): void {
  console.log();
  const openOnGreen = new RegExp("^s*@pytorchbots+?openOnGreen.*");

  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    if (commentBody.match(openOnGreen)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment(ctx, "confused");
        return;
      } else {
        await reactOnComment(ctx, "+1");
      }
    }
  });

  app.on("workflow_run.completed", async (ctx) => {
    ctx.payload.workflow_run.
  });
}
