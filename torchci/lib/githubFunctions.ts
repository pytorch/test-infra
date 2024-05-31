import { getOctokitWithUserToken } from "./github";

export async function commentOnPR(
  owner: string,
  repo: string,
  issue_number: string,
  message: string,
  accessToken: string,
  onComplete: Function
) {
  // Prevent devs from accidentally reverting something in DEV
  if (process.env.NODE_ENV !== "production") {
    repo = "test-infra";
    issue_number = "582";
  }
  const commentUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}/comments`;

  const response = await fetch(commentUrl, {
    method: "POST",
    body: JSON.stringify({ body: message }),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${accessToken}`,
    },
  });
  onComplete(JSON.stringify(await response.json(), undefined, 2));
}

export async function runWorkflow({
  workflowName,
  body,
  owner,
  repo,
  accessToken,
  onComplete,
  ref = "main",
}: {
  workflowName: string;
  body: any;
  owner: string;
  repo: string;
  accessToken: string;
  onComplete: Function;
  ref?: string;
}) {
  const octokit = await getOctokitWithUserToken(accessToken);
  const user = await octokit.rest.users.getAuthenticated();
  if (
    user === undefined ||
    user.data === undefined ||
    user.data.login === undefined
  ) {
    return onComplete("Invalid user");
  }
  const response = octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflowName,
    ref: ref,
    inputs: body,
  });
  onComplete("Triggering workflow");
  const data = await response;
  if (data.status !== 204) {
    onComplete("Failed to trigger workflow");
  } else {
    onComplete("Workflow triggered successfully");
  }
}
