import { createAppAuth } from "@octokit/auth-app";
import nock from "nock";
import { Octokit } from "octokit";
import { Probot, ProbotOctokit } from "probot";

export function testProbot(): Probot {
  return new Probot({
    appId: 1,
    privateKey: "test",
    githubToken: "test",
    // Disable throttling & retrying requests for easier testing
    Octokit: ProbotOctokit.defaults({
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
  });
}

export function testOctokit(): Octokit {
  return new Octokit({
    retry: { enabled: false },
    throttle: { enabled: false },
  })
}

export function mockConfig(
  fileName: string,
  content: string,
  repoKey: string
): void {
  const configPayload = require("./fixtures/config.json");
  configPayload["content"] = Buffer.from(content).toString("base64");
  configPayload["name"] = fileName;
  configPayload["path"] = `.github/${fileName}`;
  nock("https://api.github.com")
    .get(
      `/repos/${repoKey}/contents/${encodeURIComponent(`.github/${fileName}`)}`
    )
    .reply(200, content);
}

export function mockAccessToken(): void {
  nock("https://api.github.com")
    .post("/app/installations/2/access_tokens")
    .reply(200, { token: "test" });
}
