import { Octokit, App } from "octokit";
import { createAppAuth } from "@octokit/auth-app";

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
      // optional: this will make appOctokit authenticate as app (JWT)
      //           or installation (access token), depending on the request URL
      installationId: installation.data.id,
    },
  });
}
