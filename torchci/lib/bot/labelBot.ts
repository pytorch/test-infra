import { Probot } from "probot";
import { reactOnComment, addComment, addLabels } from "./botUtils";

function labelBot(app: Probot): void {
    // labels start with non space char \\w and follow by list of labels separated by comma
    const labelCommand = new RegExp(
        "@pytorchbot\\s+label\\s+(\\w[\\w\\s.:,&-/]+)"
    );

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

        /**
         * 1. Check if it is a pull request
         * 2. Get all existing repo labels
         * 3. parse labels from command
         * 4. Find valid and invalid labels
         * 5. Add valid labels to pr, report invalid labels
         */
        const match = commentBody.match(labelCommand);
        if (match == null) {
            return;
        }
        if (!ctx.payload.issue.pull_request) {
            // Issue, not pull request.
            await addComment(ctx, "Can add labels only to PRs, not issues");
            return;
        }
        const repoLabels = new Set(await existingRepoLabels());
        // remove unnecessary spaces from labels
        const labelsToAdd = match[1].split(",").map((s) => s.trim());

        const filteredLabels = labelsToAdd.filter((l) => repoLabels.has(l));
        const invalidLabels = labelsToAdd.filter((l) => !repoLabels.has(l));
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
