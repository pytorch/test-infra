import { Probot } from "probot";

function cancelWorkflowsOnCloseBot(app: Probot): void {
  app.on("pull_request.closed", async (ctx) => {
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const prNumber = ctx.payload.pull_request.number;
    const senderLogin = ctx.payload.sender.login;
    const senderId = ctx.payload.sender.id;

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

    const graphqlquery = `query ($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            commits(last: 1) {
              nodes {
                commit {
                  checkSuites(first: 30, filterBy: {appId: 15368}) {
                    nodes {
                      status
                      workflowRun {
                        databaseId
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`;
    const response: any = await ctx.octokit.graphql(graphqlquery, {
      owner,
      repo,
      prNumber,
    });

    await Promise.all(
      response.repository.pullRequest.commits.nodes[0].commit.checkSuites.nodes
        .filter((node: any) => node.status != "COMPLETED")
        .map(
          async (node: any) =>
            await ctx.octokit.rest.actions.cancelWorkflowRun({
              owner,
              repo,
              run_id: node.workflowRun.databaseId,
            })
        )
    );
    return;
  });
}

export default cancelWorkflowsOnCloseBot;
