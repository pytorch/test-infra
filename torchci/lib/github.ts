import { Octokit, App } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { CommitData } from "./types";

// Retrieve an Octokit instance authenticated as PyTorchBot's installation on
// the given repo.
export async function getOctokit(
  owner: string,
  repo: string
): Promise<Octokit> {
  let privateKey = process.env.PRIVATE_KEY as string;
  privateKey = Buffer.from(privateKey, "base64").toString();

  const app = new App({
    appId: process.env.APP_ID!,
    privateKey,
  });
  const installation = await app.octokit.request(
    "GET /repos/{owner}/{repo}/installation",
    { owner, repo }
  );

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.APP_ID,
      privateKey,
      installationId: installation.data.id,
    },
  });
}

const PR_REGEX = /Pull Request resolved: .*?(\d+)/;
const PHAB_REGEX = /Differential Revision: (D.*)/;
const EXPORTED_PHAB_REGEX = /Differential Revision: \[(.*)\]/;

// Turns a JSON response from octokit into our CommitData type.
export function commitDataFromResponse(data: any): CommitData {
  const message = data.commit.message;
  const prMatch = message.match(PR_REGEX);
  let prNum = null;
  if (prMatch) {
    prNum = parseInt(prMatch[1]);
  }

  const phabMatch = message.match(PHAB_REGEX);
  let diffNum = null;
  if (phabMatch) {
    diffNum = phabMatch[1];
  }

  if (diffNum === null) {
    const exportedPhabMatch = message.match(EXPORTED_PHAB_REGEX);
    if (exportedPhabMatch) {
      diffNum = exportedPhabMatch[1];
    }
  }

  return {
    time: data.commit.committer!.date as string,
    sha: data.sha,
    commitUrl: data.html_url,
    commitTitle: data.commit.message.split("\n")[0],
    commitMessageBody: data.commit.message,
    prNum,
    diffNum,
  };
}
