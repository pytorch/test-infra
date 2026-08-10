import { createAppAuth } from "@octokit/auth-app";
import { App, Octokit } from "octokit";
import { CommitData } from "./types";

// Preview deployments authenticate as their own GitHub App, so a preview can
// never act as the production bot. Falls back to the production pair when the
// preview one is not configured, to keep existing previews working.
function getAppCredentials(): { appId: string; privateKey: string } {
  const isPreview = process.env.VERCEL_ENV === "preview";
  const appId = (isPreview && process.env.PREVIEW_APP_ID) || process.env.APP_ID;
  const encodedPrivateKey =
    (isPreview && process.env.PREVIEW_PRIVATE_KEY) || process.env.PRIVATE_KEY;

  if (!appId || !encodedPrivateKey) {
    const names = isPreview
      ? "PREVIEW_APP_ID and PREVIEW_PRIVATE_KEY"
      : "APP_ID and PRIVATE_KEY";
    throw new Error(`Missing GitHub App credentials: ${names} are not set.`);
  }

  // Both variables hold the base64 of the whole .pem file, not the PEM text.
  return {
    appId,
    privateKey: Buffer.from(encodedPrivateKey, "base64").toString(),
  };
}

// Retrieve an Octokit instance authenticated as PyTorchBot's installation on
// the given repo.
export async function getOctokit(
  owner: string,
  repo: string
): Promise<Octokit> {
  const { appId, privateKey } = getAppCredentials();

  const app = new App({
    appId,
    privateKey,
  });

  let installation;
  try {
    installation = await app.octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo }
    );
  } catch (e) {
    console.error(e);
    throw new Error(
      `Failed to get installation for repo ${owner}/${repo}. Is the app installed on this repo?`
    );
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId: installation.data.id,
    },
  });
}

export async function getOctokitWithUserToken(token: string): Promise<Octokit> {
  return new Octokit({
    auth: token,
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
    author: data.author?.login ?? data.commit.author.name,
    authorUrl: data.author?.html_url ?? null,
    time: data.commit.committer!.date as string,
    sha: data.sha,
    commitUrl: data.html_url,
    commitTitle: data.commit.message.split("\n")[0],
    commitMessageBody: data.commit.message,
    prNum,
    diffNum,
  };
}
