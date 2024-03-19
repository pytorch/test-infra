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
  });
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

export function mockPermissions(
  repoFullName: string,
  user: string,
  permission: string = "write"
) {
  return nock("https://api.github.com")
    .get(`/repos/${repoFullName}/collaborators/${user}/permission`)
    .reply(200, {
      permission: permission,
    });
}

export function mockApprovedWorkflowRuns(
  repoFullname: string,
  headSha: string,
  approved: boolean
) {
  return nock("https://api.github.com")
    .get(`/repos/${repoFullname}/actions/runs?head_sha=${headSha}`)
    .reply(200, {
      workflow_runs: [
        {
          event: "pull_request",
          conclusion: approved ? "success" : "action_required",
        },
      ],
    });
}

export function mockGetPR(repoFullName: string, prNumber: number, body: any) {
  return nock("https://api.github.com")
    .get(`/repos/${repoFullName}/pulls/${prNumber}`)
    .reply(200, body);
}

export function mockPostComment(
  repoFullName: string,
  prNumber: number,
  containedStrings: string[]
) {
  return nock("https://api.github.com")
    .post(`/repos/${repoFullName}/issues/${prNumber}/comments`, (body) => {
      for (const containedString of containedStrings) {
        expect(JSON.stringify(body)).toContain(containedString);
      }
      return true;
    })
    .reply(200);
}
