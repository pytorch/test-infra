import { Probot } from "probot";
import { reactOnComment, addComment, addLabels } from "./botUtils";
import { getParser, getInputArgs } from "./cliParser";
import shlex from "shlex";

function labelBot(app: Probot): void {
  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;

    async function existingRepoLabels(): Promise<string[]> {
      const labels = await ctx.octokit.paginate(
        "GET /repos/{owner}/{repo}/labels",
        {
          owner: owner,
          repo: repo,
        }
      );
      return labels.map((d) => d.name);
    }

    const inputArgs = getInputArgs(commentBody);
    if (inputArgs.length == 0) {
      return;
    }

    let args;
    try {
      const parser = getParser();
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
      // Help will be printed by mergeBot
      return;
    }
    if (args.command != "label") {
      return;
    }

    /**
     * 1. Check if it is a pull request
     * 2. Get all existing repo labels
     * 3. parse labels from command
     * 4. Find valid and invalid labels
     * 5. Add valid labels to pr, report invalid labels
     */
    if (!ctx.payload.issue.pull_request) {
      // Issue, not pull request.
      await addComment(ctx, "Can add labels only to PRs, not issues");
      return;
    }
    const repoLabels = new Set(await existingRepoLabels());
    // remove unnecessary spaces from labels
    const labelsToAdd = args.labels.map((s: string) => s.trim());

    const filteredLabels = labelsToAdd.filter((l: string) => repoLabels.has(l));
    const invalidLabels = labelsToAdd.filter((l: string) => !repoLabels.has(l));
    if (invalidLabels.length > 0) {
      await addComment(
        ctx,
        "Didn't find following labels among repository labels: " +
          invalidLabels.join(",")
      );
    }
    if (filteredLabels.length > 0) {
      await addLabels(ctx, filteredLabels);
      await reactOnComment(ctx, "+1");
    }
  });
}

export default labelBot;
