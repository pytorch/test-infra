import { Probot } from "probot";
import { addComment, reactOnComment } from "./botUtils";
import { getHelp, getParser } from "./cliParser";
import shlex from "shlex";

const PYTORCH_BOT_USER_ID = 54816060;

function mergeBot(app: Probot): void {
  const botCommandPattern = new RegExp(/^@pytorchbot.*$/m);

  const mergeCmdPat = new RegExp(
    "^\\s*@pytorch(merge|)bot\\s+(force\\s+)?merge\\s+this\\s*(on\\s*green)?"
  );

  app.on("issue_comment.created", async (ctx) => {
    async function dispatchEvent(event_type: string, payload: any) {
      // Add common arguments to dispatched payload
      payload = {
        pr_num: ctx.payload.issue.number,
        comment_id: ctx.payload.comment.id,
        ...payload,
      };

      ctx.log(
        `Creating dispatch event of type "${event_type}" for comment ${ctx.payload.comment.html_url}`
      );
      ctx.log(`Payload: ${JSON.stringify(payload)}`);
      await ctx.octokit.repos.createDispatchEvent(
        ctx.repo({
          event_type: event_type,
          client_payload: payload,
        })
      );
      await reactOnComment(ctx, "+1");
    }

    async function handleConfused() {
      await reactOnComment(ctx, "confused");
    }

    async function handleRebase(branch: string) {
      async function comment_author_in_pytorch_org() {
        try {
          return (
            (
              await ctx.octokit.rest.orgs.getMembershipForUser({
                org: "pytorch",
                username: ctx.payload.comment.user.login,
              })
            )?.data?.state == "active"
          );
        } catch (error) {
          return false;
        }
      }

      if (
        ctx.payload.comment.user.login == ctx.payload.issue.user.login ||
        (await comment_author_in_pytorch_org())
      ) {
        await dispatchEvent("try-rebase", { branch });
      } else {
        await addComment(
          ctx,
          "You don't have permissions to rebase this PR, only the PR author and pytorch organization members may rebase this PR."
        );
      }
    }

    if (ctx.payload.comment.user.id == PYTORCH_BOT_USER_ID) {
      // This comment was made by this bot, ignore it.
      return;
    }

    const commentBody = ctx.payload.comment.body;
    const match = commentBody.match(botCommandPattern);
    if (!match) {
      return;
    }

    const command = match[0];

    if (!ctx.payload.issue.pull_request) {
      // Issue, not pull request.
      return await handleConfused();
    }

    const inputArgs = command.replace(/@pytorchbot/, "");
    let args;
    const parser = getParser();
    try {
      args = parser.parse_args(shlex.split(inputArgs));
    } catch (err: any) {
      // If the args are invalid, comment with the error + some help.
      await addComment(
        ctx,
        "❌ 🤖 pytorchbot command failed: \n```\n" +
          err.message +
          "```\n" +
          "Try `@pytorchbot help` for more info."
      );
      return;
    }

    switch (args.command) {
      case "revert":
        return await dispatchEvent("try-revert", {
          reason: args.message,
        });
      case "merge":
        return await dispatchEvent("try-merge", {
          force: args.force,
          on_green: args.green,
          all_green: args.all_green,
        });
      case "rebase": {
        let branch = "master";
        if (args.stable) {
          branch = "viable/strict";
        } else if (args.branch) {
          branch = args.branch;
        }
        return await handleRebase(branch);
      }
      case "help":
        return await addComment(ctx, getHelp());
      default:
        return await handleConfused();
    }
  });
  app.on(
    ["pull_request_review.submitted", "pull_request_review.edited"],
    async (ctx) => {
      const reviewBody = ctx.payload.review.body;
      const owner = ctx.payload.repository.owner.login;
      const repo = ctx.payload.repository.name;
      const prNum = ctx.payload.pull_request.number;
      async function addComment(comment: string) {
        ctx.log(
          `Commenting with "${comment}" for pull request ${ctx.payload.pull_request.html_url}`
        );
        await ctx.octokit.issues.createComment({
          issue_number: prNum,
          body: comment,
          owner,
          repo,
        });
      }
      async function dispatchEvent(event_type: string) {
        ctx.log(
          `Creating dispatch event of type "${event_type}" for pull request review ${ctx.payload.review.html_url}`
        );
        await ctx.octokit.repos.createDispatchEvent({
          owner,
          repo,
          event_type: event_type,
          client_payload: {
            pr_num: prNum,
          },
        });
      }

      if (reviewBody?.match(mergeCmdPat)) {
        await dispatchEvent("try-merge");
        await addComment("+1"); // REST API doesn't support reactions for code reviews.
      }
    }
  );
}

export default mergeBot;
