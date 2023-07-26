import { PullRequestReview } from "@octokit/webhooks-types";
import _ from "lodash";
import { updateDrciComments } from "pages/api/drci/drci";
import shlex from "shlex";
import { getHelp, getParser } from "./cliParser";
import PytorchBotLogger from "./pytorchbotLogger";
import {
  isPyTorchOrg,
  isPyTorchPyTorch,
  addLabels,
  hasWritePermissions as _hasWP,
  reactOnComment,
  hasWorkflowRunningPermissions as _hasWRP,
} from "./utils";

export const CIFLOW_TRUNK_LABEL = "ciflow/trunk";

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

const PR_COMMENTED = "commented";
const PR_DISMISSED = "dismissed";
const PR_CHANGES_REQUESTED = "changes_requested";
const PR_APPROVED = "approved";

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

  async getApprovalStatus(): Promise<string> {
    var reviews: PullRequestReview[] = await this.ctx.octokit.paginate(
      this.ctx.octokit.pulls.listReviews,
      {
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNum,
      }
    );

    if (!reviews.length) {
      this.ctx.log("Could not find any reviews for PR");
      return "no_reviews";
    }

    // From https://docs.github.com/en/graphql/reference/enums#commentauthorassociation
    const ALLOWED_APPROVER_ASSOCIATIONS = [
      "COLLABORATOR",
      "CONTRIBUTOR",
      "MEMBER",
      "OWNER",
    ];

    // Find the latest review offered by each authroized reviewer
    // But first sort them in case Github ever returns the list unsorted
    var latest_reviews: { [user: string]: string } = reviews
      .sort((a: PullRequestReview, b: PullRequestReview) => {
        return Date.parse(a.submitted_at + "") < Date.parse(b.submitted_at + "")
          ? -1
          : 1;
      })
      .reduce(
        (
          latest_reviews: { [user: string]: string },
          curr_review: PullRequestReview
        ) => {
          if (
            !ALLOWED_APPROVER_ASSOCIATIONS.includes(
              curr_review.author_association
            )
          ) {
            // Not an authorized approver
            return latest_reviews;
          }

          // Casing is werid here. The typescript defintion says state will be lower case, yet github
          // returns upper case. We can't trust that to remain that way, so always conver the state
          // to lowercase before any comparisons
          switch (curr_review.state.toLocaleLowerCase()) {
            case PR_COMMENTED: // Ignore mere comments
              break;
            case PR_DISMISSED: // Ignore previous reviews by this person
              delete latest_reviews[curr_review.user.login];
              break;
            case PR_CHANGES_REQUESTED:
            case PR_APPROVED:
              latest_reviews[curr_review.user.login] = curr_review.state;
              break;
            default:
              this.ctx.log(
                `Found an invalid review state '${curr_review.state}' on review id ${curr_review.id}. See ${curr_review.html_url}`
              );
          }

          return latest_reviews;
        },
        {}
      );

    // Aggregate the reviews to figure out the overall status.
    // One approval is all that's needed
    let approval_status = "";
    for (let [_, review_state] of Object.entries(latest_reviews)) {
      if (review_state.toLocaleLowerCase() == PR_APPROVED) {
        approval_status = review_state;
      }
    }

    return approval_status.toLocaleLowerCase();
  }

  async handleMerge(
    forceMessage: string,
    ignore_current: boolean,
    rebase: string | boolean,
    ic: boolean
  ) {
    const extra_data = {
      forceMessage,
      rebase,
    };
    const forceRequested = forceMessage != undefined;
    let rejection_reason = null;

    if (forceRequested) {
      rejection_reason = await this.reasonToRejectForceRequest(forceMessage);
    } else if (isPyTorchOrg(this.owner)) {
      // Ensure the PR has been signed off on
      let approval_status = await this.getApprovalStatus();
      if (approval_status !== PR_APPROVED) {
        rejection_reason =
          "This PR needs to be approved by an authorized maintainer before merge.";
      }
    }

    if (ic) {
      rejection_reason =
        "`-ic` flag is deprecated, please use `-i` instead for the same effect.";
    }

    if (rejection_reason) {
      await this.logger.log("merge-error", extra_data);
      await this.handleConfused(true, rejection_reason);
      return;
    }

    if (
      rebase &&
      !(await this.hasWorkflowRunningPermissions(
        this.ctx.payload?.comment?.user?.login
      ))
    ) {
      await this.addComment(
        "You don't have permissions to rebase this PR since you are a first time contributor.  If you think this is a mistake, please contact PyTorch Dev Infra."
      );
      rebase = false;
    }

    await this.logger.log("merge", extra_data);
    if (!forceRequested && isPyTorchPyTorch(this.owner, this.repo)) {
      let labels: string[] = this.ctx.payload?.issue?.labels.map(
        (e: any) => e["name"]
      );
      if (labels === undefined) {
        labels = this.ctx.payload?.pull_request?.labels.map(
          (e: any) => e["name"]
        );
      }

      if (
        labels !== undefined &&
        !labels.find((x) => x === CIFLOW_TRUNK_LABEL)
      ) {
        await addLabels(this.ctx, [CIFLOW_TRUNK_LABEL]);
      }
    }

    await this.dispatchEvent("try-merge", {
      force: forceRequested,
      ignore_current: ignore_current,
      rebase: rebase,
    });
    await this.ackComment();
  }

  async handleRevert(reason: string) {
    await this.logger.log("revert", { reason });
    await this.dispatchEvent("try-revert", { reason: reason });
    await this.ackComment();
  }

  async handleRebase(branch: string) {
    await this.logger.log("rebase", { branch });
    const { ctx } = this;
    if (
      await this.hasWorkflowRunningPermissions(
        ctx.payload?.comment?.user?.login
      )
    ) {
      await this.dispatchEvent("try-rebase", { branch: branch });
      await this.ackComment();
    } else {
      await this.addComment(
        "You don't have permissions to rebase this PR since you are a first time contributor.  If you think this is a mistake, please contact PyTorch Dev Infra."
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

  async hasWritePermissions(username: string): Promise<boolean> {
    return _hasWP(this.ctx, username);
  }

  async hasWorkflowRunningPermissions(username: string): Promise<boolean> {
    return _hasWRP(this.ctx, username);
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
    if (
      ciflowLabels.length > 0 &&
      !(await this.hasWorkflowRunningPermissions(
        ctx.payload?.comment?.user?.login
      ))
    ) {
      return await this.addComment(
        "Can't add following labels to PR: " +
          ciflowLabels.join(", ") +
          ". Please ping one of the reviewers for help."
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

  async handleDrCI() {
    await this.logger.log("Dr. CI");
    const { ctx, prNum, repo } = this;

    await this.ackComment();
    await updateDrciComments(ctx.octokit, repo, prNum.toString());
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
          args.ignore_current,
          args.rebase,
          args.ic
        );
      case "rebase": {
        if (!args.branch) {
          args.branch = "viable/strict";
        }
        return await this.handleRebase(args.branch);
      }
      case "label": {
        return await this.handleLabel(args.labels);
      }
      case "drci": {
        return await this.handleDrCI();
      }
      default:
        return await this.handleConfused(false);
    }
  }
}

export default PytorchBotHandler;
