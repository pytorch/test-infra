import { Probot } from "probot";
import { addComment, reactOnComment } from "./botUtils";
import { getCommand, getOptions, parseComment } from "./cliParser";

function mergeBot(app: Probot): void {
  const mergeCmdPat = new RegExp(
    "^\\s*@pytorch(merge|)bot\\s+(force\\s+)?merge\\s+this\\s*(on\\s*green)?"
  );
  const revertCmdPat = new RegExp("^\\s*@pytorch(merge|)bot\\s+revert\\s+this");
  const rebaseCmdPat = new RegExp(
    "^\\s*@pytorch(merge|)bot\\s+rebase\\s+(me|this)"
  );

  const revertExplaination = '`@pytorchbot revert -m="this breaks mac tests on trunk" -c="ignoredsignal"`' +
    '. See the [wiki](https://github.com/pytorch/pytorch/wiki/Bot-commands) for more details on the commands.';

  const revertClassifications = new Set([
    "nosignal",
    "ignoredsignal",
    "landrace",
    "weird",
    "ghfirst",
  ]);

  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const prNum = ctx.payload.issue.number;

    async function dispatchEvent(
      event_type: string,
      force: boolean = false,
      onGreen: boolean = false,
      allGreen: boolean = false,
      reason: string = "",
      stable: boolean = false
    ) {
      let payload: any = {
        pr_num: prNum,
        comment_id: ctx.payload.comment.id,
      };

      if (force) {
        payload.force = true;
      } else if (allGreen) {
        payload.all_green = true;
      } else if (onGreen) {
        payload.on_green = true;
      } else if (stable) {
        payload.stable = true
      }

      if (reason.length > 0) {
        payload.reason = reason;
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
    async function handleMerge(force: boolean, mergeOnGreen: boolean, allGreen: boolean) {
      await dispatchEvent("try-merge", force, mergeOnGreen, allGreen);
      await reactOnComment(ctx, "+1");
    }

    async function handleRevert(reason: string = "") {
      await dispatchEvent("try-revert", false, false, false, reason);
      await reactOnComment(ctx, "+1");
    }

    async function handleRebase(stable: boolean) {
      async function comment_author_in_pytorch_org() {
        try {
          return (await ctx.octokit.rest.orgs.getMembershipForUser({
            org: "pytorch",
            username: ctx.payload.comment.user.login,
          }))?.data?.state == "active";
        } catch (error) {
          return false;
        }
      }

      if (ctx.payload.comment.user.login == ctx.payload.issue.user.login || await comment_author_in_pytorch_org()) {
        await dispatchEvent("try-rebase", false, false, false, "", stable);
        await reactOnComment(ctx, "+1");
      } else {
        await addComment(
          ctx,
          "You don't have permissions to rebase this PR, only the PR author and pytorch organization members may rebase this PR."
        );
      }
    }

    async function handleHelp() {
      await addComment(
        ctx,
        "To see all options for pytorchbot, " +
        "please refer to this [page](https://github.com/pytorch/pytorch/wiki/Bot-commands)."
      );
    }

    // Valid reason contains 3+ word
    function isReasonValid(reason: string) {
      return reason.split(" ").filter((x) => x.trim().length > 1).length >= 3;
    }

    const match = commentBody.match(mergeCmdPat);
    if (match) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await handleConfused();
        return;
      }
      await handleMerge(
        typeof match[2] === "string",
        typeof match[3] === "string",
        false,
      );
      return;
    }
    const revert_match = commentBody.match(revertCmdPat);
    if (revert_match) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await handleConfused();
        return;
      }
      const reason = commentBody.substring(revert_match[0].length).trim();
      if (!isReasonValid(reason)) {
        // revert reason of 3+ words not given
        await addComment(
          ctx,
          "Revert unsuccessful: please retry the command and provide a revert reason, " +
          "e.g. @pytorchbot revert this as it breaks mac tests on trunk, see {url to logs}."
        );
        return;
      }
      await handleRevert(reason.trim());
      return;
    }
    if (commentBody.match(rebaseCmdPat)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await handleConfused();
        return;
      }
      await handleRebase(false);
      return;
    }

    const commentOptions = parseComment(commentBody);
    const cmd = getCommand(commentOptions);
    const option = getOptions(cmd, commentOptions);
    // TODO: Remove old way of parsing inputs
    if (cmd != null && option != null) {
      if (cmd === "revert") {
        if (option["message"] == null || !isReasonValid(option["message"])) {
          await addComment(
            ctx,
            "Revert unsuccessful: please retry the command and provide a revert reason, e.g. " +
            revertExplaination

          );
          return;
        }
        if (
          option["classification"] == null ||
          !revertClassifications.has(
            option["classification"].replace(/['"]+/g, "")
          )
        ) {
          const invalidClassificationMessage = option['classification'] != null ?
            `(the classification you provided was: ${option['classification']})` :
            "";
          await addComment(
            ctx,
            `Revert unsuccessful: please retry the command and provide a valid classification ${invalidClassificationMessage}.` +
            `The options for classifications are ${[...revertClassifications].join(", ")}. Example: ` +
            revertExplaination
          );
          return;
        }
        // Pass the message without quotes
        await handleRevert(option["message"].replace(/^"|"$/g, ""));
      } else if (cmd === "merge") {
        await handleMerge(option["force"], option["green"], option['allGreen']);
      } else if (cmd === "rebase") {
        await handleRebase(option["stable"]);
      } else if (cmd === "help") {
        await handleHelp();
      } else {
        await handleConfused();
      }
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
