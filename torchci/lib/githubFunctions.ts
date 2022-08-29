export async function commentOnPR(
  owner: string,
  repo: string,
  issue_number: string,
  message: string,
  accessToken: string,
  onComplete: Function
) {
  const commentUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}/comments`;
  // Prevent devs from accidentally reverting something in DEV
  if (process.env.NODE_ENV !== "production") {
    repo = "test-infra";
    issue_number = "582";
  }

  // const response = await fetch(commentUrl, {
  //   method: "POST",
  //   body: JSON.stringify({ body: message }),
  //   headers: {
  //     Accept: "application/vnd.github+json",
  //     Authorization: `token ${accessToken}`,
  //   },
  // });
  // onComplete(JSON.stringify(await response.json(), undefined, 2));
}
