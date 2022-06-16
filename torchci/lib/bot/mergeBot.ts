import { Probot } from "probot";
import { addComment, reactOnComment } from "./botUtils";
import { getHelp, getParser } from "./cliParser";
import shlex from "shlex";

function mergeBot(app: Probot): void {
  const botCommandPattern = new RegExp(/^@pytorch(merge|)bot.*$/m);

  const mergeCmdPat = new RegExp(
    "^\\s*@pytorch(merge|)bot\\s+(force\\s+)?merge\\s+this\\s*(on\\s*green)?"
  );

  const landtimeChecksAllowlist = new Set(["zengk95"]);
  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const prNum = ctx.payload.issue.number;

    async function dispatchEvent(
      event_type: string,
      force: boolean = false,
      onGreen: boolean = false,
      landChecks: boolean = false,
      reason: string = "",
      branch: string = ""
    ) {
      let payload: any = {
        pr_num: prNum,
        comment_id: ctx.payload.comment.id,
      };

      if (force) {
        payload.force = true;
      } else if (onGreen) {
        payload.on_green = true;
      } else if (landChecks) {
        payload.land_checks = true;
      }

      if (reason.length > 0) {
        payload.reason = reason;
      }

      if (branch.length > 0) {
        payload.branch = branch;
      }

      ctx.log(
        `Creating dispatch event of type "${event_type}" for comment ${ctx.payload.comment.html_url}`
      );
      await ctx.octokit.repos.createDispatchEvent({
        owner,
        repo,
        event_type: event_type,
        client_payload: payload,
      });
    }

    async function handleConfused() {
      await reactOnComment(ctx, "confused");
    }
    async function handleMerge(
      force: boolean,
      mergeOnGreen: boolean,
      landChecks: boolean
    ) {
      await dispatchEvent("try-merge", force, mergeOnGreen, landChecks);
      await reactOnComment(ctx, "+1");
    }

    async function handleRevert(reason: string) {
      await dispatchEvent("try-revert", false, false, false, reason);
      await reactOnComment(ctx, "+1");
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
        await dispatchEvent("try-rebase", false, false, false, "", branch);
        await reactOnComment(ctx, "+1");
      } else {
        await addComment(
          ctx,
          "You don't have permissions to rebase this PR, only the PR author and pytorch organization members may rebase this PR."
        );
      }
    }
    const skipUsers = [
      54816060, // pytorch-bot
      97764156, // pytorchmergebot
    ];
    if (skipUsers.includes(ctx.payload.comment.user.id)) {
      // This comment was made by this bot, ignore it.
      return;
    }

    const match = commentBody.match(botCommandPattern);
    if (!match) {
      return;
    }

    const command = match[0];

    if (!ctx.payload.issue.pull_request) {
      // Issue, not pull request.
      return await handleConfused();
    }
    const inputArgs = command.replace(/@pytorch(merge|)bot/, "");
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
          "Try `@pytorchbot --help` for more info."
      );
      return;
    }

    if (args.help) {
      return await addComment(ctx, getHelp());
    }
    switch (args.command) {
      case "revert":
        return await handleRevert(args.message);
      case "merge":
        return await handleMerge(
          args.force,
          args.green,
          args.land_checks ||
            (ctx.payload.comment.user.login != null &&
              landtimeChecksAllowlist.has(ctx.payload.comment.user.login))
        );
      case "rebase": {
        if (args.stable) {
          args.branch = "viable/strict";
        }
        return await handleRebase(args.branch);
      }
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
