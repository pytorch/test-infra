export async function revertPR(
  owner: string,
  repo: string,
  issue_number: string,
  message: string,
  classification: string,
  token: string
) {
  const commentUrl = `/repos/${owner}/${repo}/issues/${issue_number}/comments`;
  const body = JSON.stringify({ body: "" });
  const response = await fetch(commentUrl);
}

function generateRevertMessage(message: string, classification: string) {
  const msgPrefix = `@pytorchbot revert -m '${message}' -c '${classification}'\n`;
  
}

