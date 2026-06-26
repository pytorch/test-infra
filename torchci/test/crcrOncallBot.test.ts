import nock from "nock";
import { Probot } from "probot";
import crcrOncallBot from "../lib/bot/crcrOncallBot";
import * as crcrAllowlist from "../lib/crcrAllowlist";
import { clearAllowlistCache, CrcrAllowlist } from "../lib/crcrAllowlist";
import { handleScope } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const OWNER = "pytorch";
const REPO = "pytorch";
const PR_NUMBER = 42;
const HEAD_SHA = "abc123def456789";

function mockAllowlist() {
  const mockAl = CrcrAllowlist.fromYaml(`
L3:
  xpu:
    intel/torch-xpu-ops: [oncall_xpu]
L4:
  - apple/mps-backend: oncall_mps
`);
  jest
    .spyOn(crcrAllowlist, "fetchCrcrAllowlist")
    .mockResolvedValue(mockAl);
}

describe("crcrOncallBot", () => {
  let probot: Probot;

  beforeEach(() => {
    clearAllowlistCache();
    probot = utils.testProbot();
    probot.load(crcrOncallBot);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    mockAllowlist();
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  function checkRunPayload(overrides: Record<string, unknown> = {}) {
    return {
      action: "completed",
      check_run: {
        name: "crcr/intel/torch-xpu-ops/CI",
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/pytorch/pytorch/runs/12345",
        pull_requests: [{ number: PR_NUMBER }],
        ...overrides,
      },
      repository: {
        owner: { login: OWNER },
        name: REPO,
      },
    };
  }

  test("posts comment on L3 CRCR check run failure", async () => {
    const scope = nock("https://api.github.com")
      .get(`/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`)
      .reply(200, [])
      .post(
        `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`,
        (body: any) => {
          expect(body.body).toContain("<!-- crcr-oncall -->");
          expect(body.body).toContain("intel/torch-xpu-ops");
          expect(body.body).toContain("@oncall_xpu");
          expect(body.body).toContain(HEAD_SHA.slice(0, 7));
          return true;
        }
      )
      .reply(200);

    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload() as any,
      id: "1",
    });
    handleScope(scope);
  });

  test("posts comment on L4 CRCR check run failure", async () => {
    const scope = nock("https://api.github.com")
      .get(`/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`)
      .reply(200, [])
      .post(
        `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`,
        (body: any) => {
          expect(body.body).toContain("apple/mps-backend");
          expect(body.body).toContain("@oncall_mps");
          return true;
        }
      )
      .reply(200);

    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload({
        name: "crcr/apple/mps-backend/CI",
      }) as any,
      id: "2",
    });
    handleScope(scope);
  });

  test("does not comment on non-CRCR check runs", async () => {
    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload({
        name: "some-other-check",
      }) as any,
      id: "3",
    });
  });

  test("does not comment on successful check runs", async () => {
    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload({
        conclusion: "success",
      }) as any,
      id: "4",
    });
  });

  test("does not comment on neutral check runs", async () => {
    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload({
        conclusion: "neutral",
      }) as any,
      id: "5",
    });
  });

  test("dedup: does not comment twice if marker already exists", async () => {
    const scope = nock("https://api.github.com")
      .get(`/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`)
      .reply(200, [
        {
          id: 100,
          body: "<!-- crcr-oncall -->\nprevious comment",
        },
      ]);

    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload() as any,
      id: "6",
    });
    handleScope(scope);
  });

  test("does not comment when allowlist has no oncalls for repo", async () => {
    const mockAl = CrcrAllowlist.fromYaml(`
L3:
  xpu:
    intel/no-oncall-repo: []
`);
    jest
      .spyOn(crcrAllowlist, "fetchCrcrAllowlist")
      .mockResolvedValue(mockAl);

    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload({
        name: "crcr/intel/no-oncall-repo/CI",
      }) as any,
      id: "7",
    });
  });

  test("does not comment when no PR is associated", async () => {
    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload({
        pull_requests: [],
      }) as any,
      id: "8",
    });
  });

  test("does nothing for unsupported org", async () => {
    await probot.receive({
      name: "check_run" as any,
      payload: checkRunPayload({
        repository: {
          owner: { login: "some-other-org" },
          name: REPO,
        },
      }) as any,
      id: "9",
    });
  });
});
