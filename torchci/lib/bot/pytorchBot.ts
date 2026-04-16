import { Probot } from "probot";
import { getInputArgs } from "./cliParser";
import PytorchBotHandler from "./pytorchBotHandler";
import { CachedConfigTracker } from "./utils";

function pytorchBot(app: Probot): void {
  const cachedConfigTracker = new CachedConfigTracker(app);

  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const prNum = ctx.payload.issue.number;
    const commentId = ctx.payload.comment.id;

    const pytorchbotHandler = new PytorchBotHandler({
      owner,
      repo,
      prNum,
      ctx,
      url: ctx.payload.comment.html_url,
      login: ctx.payload.comment.user.login,
      commentId,
      commentBody,
      useReactions: true,
      cachedConfigTracker,
    });
    const is_pr_comment = ctx.payload.issue.pull_request != null;
    const skipUsers = [
      54816060, // pytorch-bot
      97764156, // pytorchmergebot
    ];
    if (skipUsers.includes(ctx.payload.comment.user.id)) {
      // This comment was made by this bot, ignore it.
      return;
    }

    const inputArgs = getInputArgs(commentBody);
    if (inputArgs.length == 0) {
      return;
    }
    await pytorchbotHandler.handlePytorchCommands(inputArgs, is_pr_comment);
  });

  app.on(
    ["pull_request_review.submitted", "pull_request_review.edited"],
    async (ctx) => {
      const reviewBody = ctx.payload.review.body;
      const owner = ctx.payload.repository.owner.login;
      const repo = ctx.payload.repository.name;
      const prNum = ctx.payload.pull_request.number;
      const commentId = ctx.payload.review.id;

      const pytorchbotHandler = new PytorchBotHandler({
        owner,
        repo,
        prNum,
        ctx,
        url: ctx.payload.pull_request.html_url,
        login: ctx.payload.pull_request.user.login,
        commentId,
        commentBody: reviewBody ?? "",
        useReactions: false,
        cachedConfigTracker,
      });
      if (reviewBody == null) {
        return;
      }

      const inputArgs = getInputArgs(reviewBody);
      if (inputArgs.length == 0) {
        return;
      }

      await pytorchbotHandler.handlePytorchCommands(inputArgs);
    }
  );
}

export default pytorchBot;
