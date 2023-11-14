import { Probot } from "probot";

function cancelWorkflowsOnCloseBot(app: Probot): void {
  app.on("pull_request.closed", async (ctx) => {
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const senderLogin = ctx.payload.sender.login;
    const senderId = ctx.payload.sender.id;
    const headSha = ctx.payload.pull_request.head.sha;

    if (owner !== "pytorch" || repo !== "pytorch") {
      return;
    }

    if (
      senderLogin == "pytorchmergebot" ||
      senderLogin == "pytorchbot" ||
      senderLogin == "pytorch-bot[bot]" ||
      senderId == 97764156 || // pytorchmergebot's id
      senderId == 54816060 || // pytorch-bot's id
      senderId == 21957446 // pytorchbot's id
    ) {
      return;
    }

    const diff = await ctx.octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: "main",
      head: headSha,
    });

    if (diff.data.merge_base_commit.sha == headSha) {
      // PR got made with main branch as head
      return;
    }

    const workflowRuns = await ctx.octokit.paginate(
      ctx.octokit.actions.listWorkflowRunsForRepo,
      {
        owner,
        repo,
        head_sha: headSha,
        per_page: 30,
      }
    );

    await Promise.all(
      workflowRuns
        .filter((workflowRun) => workflowRun.status != "completed")
        .map(
          async (workflowRun) =>
            await ctx.octokit.rest.actions.cancelWorkflowRun({
              owner,
              repo,
              run_id: workflowRun.id,
            })
        )
    );
    return;
  });
}

export default cancelWorkflowsOnCloseBot;
