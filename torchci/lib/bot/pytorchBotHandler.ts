import shlex from "shlex";
import { addLabels, reactOnComment } from "./botUtils";
import { getHelp, getParser } from "./cliParser";
import { isInLandCheckAllowlist } from "./rolloutUtils";

class PytorchBotHandler {
  ctx: any;
  useReactions: boolean;
  owner: string;
  repo: string;
  prNum: number;
  url: string;
  commentId: number;
  login: string;

  mergeCmdPat = new RegExp(
    "^\\s*@pytorch(merge|)bot\\s+(force\\s+)?merge\\s+this\\s*(on\\s*green)?"
  );
  forceMergeMessagePat = new RegExp("^\\s*\\S+\\s+\\S+.*");

  constructor(
    owner: string,
    repo: string,
    prNum: number,
    ctx: any,
    url: string,
    login: string,
    commentId: number,
    useReactions: boolean
  ) {
    this.owner = owner;
    this.repo = repo;
    this.prNum = prNum;
    this.ctx = ctx;
    this.url = url;
    this.login = login;
    this.commentId = commentId;
    this.useReactions = useReactions;
  }

  async ackComment() {
    if (this.useReactions) {
      await reactOnComment(this.ctx, "+1");
    } else {
      await this.addComment("+1");
    }
  }

  async dispatchEvent(
    event_type: string,
    force: boolean = false,
    onGreen: boolean = false,
    landChecks: boolean = false,
    reason: string = "",
    branch: string = ""
  ) {
    const { owner, repo, url, ctx, prNum, commentId } = this;
    let payload: any = {
      pr_num: prNum,
      comment_id: commentId,
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
      `Creating dispatch event of type "${event_type}" for comment ${url}`
    );
    await this.ctx.octokit.repos.createDispatchEvent({
      owner: owner,
      repo: repo,
      event_type: event_type,
      client_payload: payload,
    });
  }

  async addComment(comment: string) {
    const { ctx, owner, repo, prNum, url } = this;
    ctx.log(`Commenting with "${comment}" for pull request ${url}`);
    await this.ctx.octokit.issues.createComment({
      issue_number: prNum,
      body: comment,
      owner: owner,
      repo: repo,
    });
  }

  async handleConfused(
    leaveMessage: boolean,
    message: string = "@pytorch bot did not understand your command. Please try `@pytorchbot --help` for other commands."
  ) {
    if (this.useReactions) {
      await reactOnComment(this.ctx, "confused");
    }
    if (leaveMessage) {
      await this.addComment(message);
    }
  }

  isValidForceMergeMessage(message: string): boolean {
    // We can enforce  the merge message format here, for example, rejecting
    // all messages not in the following format `[CATEGORY] description`.
    //
    // However, it seems too strict to enforce a fixed set of categories right
    // away without conducting a user study for all common use cases of force
    // merge first. So the message is just a free form text for now
    const matches = message?.match(this.forceMergeMessagePat);
    return matches != undefined && matches.length != 0;
  }

  async handleMerge(
    forceMessage: string,
    mergeOnGreen: boolean,
    landChecks: boolean
  ) {
    const isForced = forceMessage != undefined;
    const isValidMessage = this.isValidForceMergeMessage(forceMessage);

    if (!isForced || isValidMessage) {
      await this.dispatchEvent("try-merge", isForced, mergeOnGreen, landChecks);
      await this.ackComment();
    } else {
      await this.handleConfused(
        true,
        "You need to provide a reason for using force merge, in the format `@pytorchbot merge -f '[CATEGORY] Explanation'`. " +
          "With [CATEGORY] being one the following:\n" +
          " EMERGENCY - an emergency fix to quickly address an issue\n" +
          " MINOR - a minor fix such as cleaning locally unused variables, which shouldn't break anything\n" +
          " PRE_TESTED - a previous CI run tested everything and you've only added minor changes like fixing lint\n" +
          " OTHER - something not covered above"
      );
    }
  }

  async handleRevert(reason: string) {
    await this.dispatchEvent("try-revert", false, false, false, reason);
    await this.ackComment();
  }

  async handleRebase(branch: string) {
    const { ctx } = this;
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
      await this.dispatchEvent("try-rebase", false, false, false, "", branch);
      await this.ackComment();
    } else {
      await this.addComment(
        "You don't have permissions to rebase this PR, only the PR author and pytorch organization members may rebase this PR."
      );
    }
  }

  async existingRepoLabels(): Promise<string[]> {
    const { ctx, owner, repo } = this;
    const labels = await ctx.octokit.paginate(
      "GET /repos/{owner}/{repo}/labels",
      {
        owner: owner,
        repo: repo,
      }
    );
    return labels.map((d: any) => d.name);
  }

  async handleLabel(labels: string[]) {
    const { ctx } = this;
    /**
     * 1. Get all existing repo labels
     * 2. Parse labels from command
     * 3. Find valid and invalid labels
     * 4. Add valid labels to pr, report invalid labels
     */
    const repoLabels = new Set(await this.existingRepoLabels());
    // remove unnecessary spaces from labels
    const labelsToAdd = labels.map((s: string) => s.trim());

    const filteredLabels = labelsToAdd.filter((l: string) => repoLabels.has(l));
    const invalidLabels = labelsToAdd.filter((l: string) => !repoLabels.has(l));
    if (invalidLabels.length > 0) {
      await this.addComment(
        "Didn't find following labels among repository labels: " +
          invalidLabels.join(",")
      );
    }
    if (filteredLabels.length > 0) {
      await addLabels(ctx, filteredLabels);
      await this.ackComment();
    }
  }

  async handlePytorchCommands(inputArgs: string) {
    let args;
    try {
      const parser = getParser();
      args = parser.parse_args(shlex.split(inputArgs));
    } catch (err: any) {
      // If the args are invalid, comment with the error + some help.
      await this.addComment(
        "❌ 🤖 pytorchbot command failed: \n```\n" +
          err.message +
          "```\n" +
          "Try `@pytorchbot --help` for more info."
      );
      return;
    }

    if (args.help) {
      return await this.addComment(getHelp());
    }
    switch (args.command) {
      case "revert":
        return await this.handleRevert(args.message);
      case "merge":
        return await this.handleMerge(
          args.force,
          args.green,
          args.land_checks ||
            (this.login != null && isInLandCheckAllowlist(this.login))
        );
      case "rebase": {
        if (args.stable) {
          args.branch = "viable/strict";
        }
        return await this.handleRebase(args.branch);
      }
      case "label": {
        return await this.handleLabel(args.labels);
      }
      default:
        return await this.handleConfused(false);
    }
  }
}

export default PytorchBotHandler;
