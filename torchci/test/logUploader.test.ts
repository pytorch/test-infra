import logUploader, {
  isRepoEnabled,
  parseRepoAllowlist,
} from "lib/bot/logUploader";
import * as lambda from "lib/lambda";
import nock from "nock";
import { Probot } from "probot";
import * as utils from "./utils";

nock.disableNetConnect();

function workflowJobPayload({
  owner = "meta-pytorch",
  name = "torchcomms",
  action = "completed",
  id = 12345,
  conclusion = "failure" as string | null,
} = {}) {
  return {
    action,
    workflow_job: { id, conclusion },
    repository: {
      full_name: `${owner}/${name}`,
      name,
      owner: { login: owner },
    },
  };
}

describe("parseRepoAllowlist", () => {
  test("an unset value disables the handler", () => {
    expect(parseRepoAllowlist(undefined).size).toBe(0);
    expect(parseRepoAllowlist("").size).toBe(0);
  });

  test("entries are trimmed and lowercased", () => {
    expect(parseRepoAllowlist(" Pytorch/PyTorch , meta-pytorch/* ")).toEqual(
      new Set(["pytorch/pytorch", "meta-pytorch/*"])
    );
  });

  test("empty entries from a trailing comma are dropped", () => {
    expect(parseRepoAllowlist("pytorch/pytorch,,").size).toBe(1);
  });
});

describe("isRepoEnabled", () => {
  test("matches an exact repo", () => {
    const allowlist = parseRepoAllowlist("pytorch/pytorch");
    expect(isRepoEnabled(allowlist, "pytorch", "pytorch")).toBe(true);
    expect(isRepoEnabled(allowlist, "pytorch", "executorch")).toBe(false);
  });

  test("matches a whole org via a wildcard", () => {
    const allowlist = parseRepoAllowlist("meta-pytorch/*");
    expect(isRepoEnabled(allowlist, "meta-pytorch", "torchcomms")).toBe(true);
    expect(isRepoEnabled(allowlist, "meta-pytorch", "monarch")).toBe(true);
    expect(isRepoEnabled(allowlist, "pytorch", "pytorch")).toBe(false);
  });

  test("an org wildcard does not leak into a similarly named org", () => {
    const allowlist = parseRepoAllowlist("pytorch/*");
    expect(isRepoEnabled(allowlist, "meta-pytorch", "torchcomms")).toBe(false);
  });

  test("comparison is case insensitive", () => {
    const allowlist = parseRepoAllowlist("PyTorch/PyTorch");
    expect(isRepoEnabled(allowlist, "pytorch", "pytorch")).toBe(true);
  });
});

describe("logUploader", () => {
  let probot: Probot;
  let invoke: jest.SpyInstance;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(logUploader);
    invoke = jest.spyOn(lambda, "invokeLogUploader").mockResolvedValue();
    process.env.LOG_UPLOADER_REPOS = "meta-pytorch/*,pytorch/pytorch";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
    delete process.env.LOG_UPLOADER_REPOS;
  });

  async function receive(payload: any) {
    await probot.receive({ name: "workflow_job", payload, id: "1" } as any);
  }

  test("queues an upload for a completed job on an allowlisted repo", async () => {
    await receive(workflowJobPayload());

    expect(invoke).toHaveBeenCalledWith({
      repo: "meta-pytorch/torchcomms",
      job_id: 12345,
      conclusion: "failure",
    });
  });

  test("ignores anything but the completed action", async () => {
    // workflow_job also fires on queued and in_progress, where there is no log
    // to fetch yet. Uploading then would archive a truncated log.
    await receive(workflowJobPayload({ action: "queued" }));
    await receive(workflowJobPayload({ action: "in_progress" }));

    expect(invoke).not.toHaveBeenCalled();
  });

  test("skips a repo that is not on the allowlist", async () => {
    await receive(workflowJobPayload({ owner: "pytorch", name: "executorch" }));

    expect(invoke).not.toHaveBeenCalled();
  });

  test("skips an org the bot does not serve, even if allowlisted", async () => {
    // The allowlist narrows the org gate, it must not widen it.
    process.env.LOG_UPLOADER_REPOS = "someoneelse/*";
    await receive(workflowJobPayload({ owner: "someoneelse", name: "repo" }));

    expect(invoke).not.toHaveBeenCalled();
  });

  test("does nothing when the allowlist is unset", async () => {
    delete process.env.LOG_UPLOADER_REPOS;
    await receive(workflowJobPayload());

    expect(invoke).not.toHaveBeenCalled();
  });

  test("passes a null conclusion through rather than dropping the job", async () => {
    await receive(workflowJobPayload({ conclusion: null }));

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: null })
    );
  });

  test.each([
    ["the role cannot invoke the function", "AccessDeniedException"],
    ["credentials are missing entirely", "MissingAwsCredentialsError"],
    ["the Lambda API is unreachable", "TimeoutError"],
    ["Lambda throttles us", "TooManyRequestsException"],
  ])("a failed invoke does not fail the webhook when %s", async (_l, name) => {
    // Throwing here would make GitHub redeliver the event and re-run every other
    // handler, to retry something Dr.CI repairs on its own.
    const error = new Error(name);
    error.name = name;
    invoke.mockRejectedValue(error);

    await expect(receive(workflowJobPayload())).resolves.not.toThrow();
  });
});
