import nock from "nock";

export function nockTracker(
  contents: string,
  ghaPath: string = "ezyang/testing-ideal-computing-machine",
  configContent: string = "tracking_issue: 6"
): void {
  // Setup mock for the "tracking issue" which specifies where
  // CC bot can get labels
  const configPayload = require("./fixtures/config.json");
  configPayload["content"] = Buffer.from(configContent).toString("base64");
  nock("https://api.github.com")
    .get(
      "/repos/" +
        ghaPath +
        "/contents/" +
        encodeURIComponent(".github/pytorch-probot.yml")
    )
    .reply(200, configContent);

  const payload = require("./fixtures/issue.json");
  payload["body"] = contents;
  nock("https://api.github.com")
    .get("/repos/" + ghaPath + "/issues/6")
    .reply(200, payload);
}

export function requireDeepCopy(fileName: string) {
  return JSON.parse(JSON.stringify(require(fileName)));
}

export function handleScope(scope: nock.Scope) {
  if (!scope.isDone()) {
    console.error("pending mocks: %j", scope.pendingMocks());
  }
  scope.done();
}