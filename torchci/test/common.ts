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
  return deepCopy(require(fileName));
}

export function deepCopy(obj: any) {
  return JSON.parse(JSON.stringify(obj));
}

export function handleScope(scope: nock.Scope | nock.Scope[]) {
  function scopeIsDone(s: nock.Scope) {
    if (!s.isDone()) {
      console.error("pending mocks: %j", s.pendingMocks());
    }
    s.done();
  }
  if (Array.isArray(scope)) {
    for (const s of scope) {
      scopeIsDone(s);
    }
  } else {
    scopeIsDone(scope);
  }
}
