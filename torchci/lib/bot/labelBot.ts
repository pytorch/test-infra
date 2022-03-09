import { Probot } from "probot";

function labelBot(app: Probot): void {
  // labels start with non space char \\w and follow by list of labels separated by comma
  const labelCommand = new RegExp(
    "@pytorchbot\\s+label\\s+(\\w[\\w\\s.:,&-/]+)"
  );

  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const commentId = ctx.payload.comment.id;
    const prNum = ctx.payload.issue.number;
    // maximum specified in the doc
    const labelsPerPage = 100;

    async function reactOnComment(reaction: "+1" | "confused") {
      await ctx.octokit.reactions.createForIssueComment({
        comment_id: commentId,
        content: reaction,
        owner,
        repo,
      });
    }

    async function addComment(message: string) {
      await ctx.octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNum,
        body: message,
      });
    }

    async function addLabels(labelsToAdd: string[]) {
      await ctx.octokit.issues.addLabels({
        owner: owner,
        repo: repo,
        issue_number: prNum,
        labels: labelsToAdd,
      });
    }

    async function loadExistingLabelsNamesPage(
      page: number
    ): Promise<string[]> {
      const labels = await ctx.octokit.issues.listLabelsForRepo({
        owner: owner,
        repo: repo,
        per_page: labelsPerPage,
        page: page,
      });
      return labels.data.map((d) => d.name);
    }

    async function loadExistingRepoLabelsNames(): Promise<string[]> {
      let allLabels = [];
      let page = 0;
      let labels = await loadExistingLabelsNamesPage(page);
      allLabels.push(...labels);
      while (labels.length == labelsPerPage) {
        page++;
        labels = await loadExistingLabelsNamesPage(page);
        allLabels.push(...labels);
      }
      return allLabels;
    }

    /**
     * 1. Check if it is pull request
     * 2. Get all existing repo labels
     * 3. parse labels from command
     * 4. Find valid and invalid labels
     * 5. Add valid labels to pr, report invalid labels
     */
    if (commentBody.match(labelCommand)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment("confused");
        return;
      }
      const regexExecLabels = labelCommand.exec(commentBody);
      if (regexExecLabels != null) {
        const repoLabels = new Set(await loadExistingRepoLabelsNames());
        // remove unnecessary spaces from labels
        const labelsToAdd = regexExecLabels[1].split(",").map((s) => s.trim());

        const filteredLabels = labelsToAdd.filter((l) => repoLabels.has(l));
        const invalidLabels = labelsToAdd.filter((l) => !repoLabels.has(l));
        if (invalidLabels.length > 0) {
          await addComment(
            "Didn't find following labels among repository labels: " +
              invalidLabels.join(",")
          );
        }
        if (filteredLabels.length > 0) {
          await addLabels(filteredLabels);
          await reactOnComment("+1");
        }
      }
    }
  });
}

export default labelBot;
