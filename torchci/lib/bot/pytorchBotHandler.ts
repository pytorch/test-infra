import _ from "lodash";
import shlex from "shlex";
import { addLabels, reactOnComment } from "./botUtils";
import { getHelp, getParser } from "./cliParser";
import PytorchBotLogger from "./pytorchbotLogger";
import { isInLandCheckAllowlist } from "./rolloutUtils";

export interface PytorchbotParams {
  owner: string;
  repo: string;
  prNum: number;
  ctx: any;
  url: string;
  login: string;
  commentId: number;
  commentBody: string;
  useReactions: boolean;
}

class PytorchBotHandler {
  ctx: any;
  useReactions: boolean;
  owner: string;
  repo: string;
  prNum: number;
  url: string;
  commentId: number;
  login: string;
  commentBody: string;

  forceMergeMessagePat = new RegExp("^\\s*\\S+\\s+\\S+.*");

  logger: PytorchBotLogger;

  constructor(params: PytorchbotParams) {
    this.owner = params.owner;
    this.repo = params.repo;
    this.prNum = params.prNum;
    this.ctx = params.ctx;
    this.url = params.url;
    this.login = params.login;
    this.commentId = params.commentId;
    this.commentBody = params.commentBody;
    this.useReactions = params.useReactions;

    this.logger = new PytorchBotLogger(params);
  }

  async ackComment() {
    if (this.useReactions) {
      await reactOnComment(this.ctx, "+1");
    } else {
      await this.addComment("+1");
    }
  }

  async dispatchEvent(event_type: string, payload: any) {
    const { owner, repo, url, ctx, prNum, commentId } = this;

    let filtered_payload = _.pickBy(payload, function (val) {
      return val !== "" && val !== false;
    });

    let client_payload = {
      pr_num: prNum,
      comment_id: commentId,
      ...filtered_payload,
    };

    ctx.log(
      `Creating dispatch event of type "${event_type}" for comment ${url}`
    );
    await this.ctx.octokit.repos.createDispatchEvent({
      owner: owner,
      repo: repo,
      event_type: event_type,
      client_payload: client_payload,
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
    await this.logger.log("confused", { message });
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

  async reasonToRejectForceRequest(
    forceMessage: string
  ): Promise<string | null> {
    const { ctx } = this;

    const hasWritePermission = await this.hasWritePermissions(
      ctx.payload?.comment?.user?.login
    );
    if (!hasWritePermission) {
      return "You are not authorized to force merges to this repository. Please use the regular `@pytorchmergebot merge` command instead";
    }

    const isValidMessage = this.isValidForceMergeMessage(forceMessage);
    if (!isValidMessage) {
      return `You need to provide a reason for using force merge, in the format @pytorchbot merge -f 'Explanation'.
The explanation needs to be clear on why this is needed. Here are some good examples:
* Bypass checks due to unrelated upstream failures from ...
* This is a minor fix to ..., which shouldn't break anything
* This is pre-tested in a previous CI run
* Bypass flaky ... check`;
    }

    return null;
  }

  async handleMerge(
    forceMessage: string,
    mergeOnGreen: boolean,
    landChecks: boolean,
    landChecksEnrolled: boolean,
    rebase: string | boolean
  ) {
    const extra_data = {
      forceMessage,
      mergeOnGreen,
      landChecks,
      landChecksEnrolled,
      rebase,
    };
    const forceRequested = forceMessage != undefined;
    let rejection_reason = null;

    if (forceRequested) {
      rejection_reason = await this.reasonToRejectForceRequest(forceMessage);
    }

    if (!rejection_reason) {
      if (rebase === true) {
        const { ctx, owner, repo } = this;
        rebase = (
          await ctx.octokit.rest.repos.get({
            owner,
            repo,
          })
        )?.data?.default_branch;
      }
      await this.logger.log("merge", extra_data);
      await this.dispatchEvent("try-merge", {
        force: forceRequested,
        on_green: mergeOnGreen,
        land_checks: landChecks || landChecksEnrolled,
        rebase: rebase,
      });
      await this.ackComment();
    } else {
      await this.logger.log("merge-error", extra_data);
      await this.handleConfused(true, rejection_reason);
    }
  }

  async handleRevert(reason: string) {
    await this.logger.log("revert", { reason });
    await this.dispatchEvent("try-revert", { reason: reason });
    await this.ackComment();
  }

  async handleRebase(branch: string) {
    await this.logger.log("rebase", { branch });
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
      await this.dispatchEvent("try-rebase", { branch: branch });
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

  async getUserPermissions(username: string): Promise<string> {
    const { ctx, owner, repo } = this;
    const res = await ctx.octokit.repos.getCollaboratorPermissionLevel({
      owner: owner,
      repo: repo,
      username,
    });
    return res?.data?.permission;
  }

  async hasWritePermissions(username: string): Promise<boolean> {
    const permissions = await this.getUserPermissions(username);
    return permissions === "admin" || permissions === "write";
  }

  async handleLabel(labels: string[]) {
    await this.logger.log("label", { labels });
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
    const ciflowLabels = labelsToAdd.filter((l: string) =>
      l.startsWith("ciflow/")
    );
    const hasWritePermission = await this.hasWritePermissions(
      ctx.payload?.comment?.user?.login
    );
    if (!hasWritePermission && ciflowLabels.length > 0) {
      return await this.addComment(
        "Can't add following labels to PR: " +
          ciflowLabels.join(", ") +
          " Please ping one of the reviewers for help."
      );
    }
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
          args.land_checks,
          this.login != null && isInLandCheckAllowlist(this.login),
          args.rebase
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
