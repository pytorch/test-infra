import { IssueData } from "lib/types";
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
  repoKey: string | RegExp = ".*"
): void {
  const configPayload = require("./fixtures/config.json");
  configPayload["content"] = Buffer.from(content).toString("base64");
  configPayload["name"] = fileName;
  configPayload["path"] = `.github/${fileName}`;
  nock("https://api.github.com")
    .get(
      // The use of regex here means that if the repokey or the filename contain
      // regex special characters, they will be viewed as regex.  The main one
      // to worry about is `.` but I think it will cause minimal problems
      RegExp(
        `/repos/${repoKey}/contents/${encodeURIComponent(
          `.github/${fileName}`
        )}`
      )
    )
    .times(2)
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

export function mockAddLabels(
  labels: string[],
  repoFullName: string,
  prNumber: number
) {
  const scope = nock("https://api.github.com")
    .post(`/repos/${repoFullName}/issues/${prNumber}/labels`, (body) => {
      expect(body).toMatchObject({ labels: labels });
      return true;
    })
    .reply(200, {});
  return scope;
}

export function mockHasApprovedWorkflowRun(repoFullName: string) {
  nock("https://api.github.com")
    .get((uri) => uri.startsWith(`/repos/${repoFullName}/actions/runs`))
    .reply(200, {
      workflow_runs: [
        {
          event: "pull_request",
          conclusion: "success",
        },
      ],
    });
}

export function genIssueData(
  nonDefaultInputs: {
    number?: number;
    title?: string;
    html_url?: string;
    state?: "open" | "closed";
    body?: string;
    updated_at?: string;
    author_association?: string;
    labels?: string[];
  } = {}
): IssueData {
  return {
    number: 1,
    title: "test issue",
    html_url: "test url",
    state: "open",
    body: "",
    updated_at: "1899-07-13 19:34:03",
    author_association: "MEMBER",
    labels: [],
    ...nonDefaultInputs,
  };
}
