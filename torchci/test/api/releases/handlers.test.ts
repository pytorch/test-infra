import { GET as getArtifacts } from "app/api/releases/[version]/artifacts/route";
import { GET as getConfig } from "app/api/releases/[version]/config/route";
import { GET as getCrcr } from "app/api/releases/[version]/crcr/route";
import { GET as getMilestone } from "app/api/releases/[version]/milestone/route";
import { GET as getBoard } from "app/api/releases/[version]/route";
import { GET as getIndex } from "app/api/releases/route";
import { clearConfigCache } from "lib/api/releases/config";
import { encodeArtifactCursor } from "lib/api/releases/cursor";
import {
  ArtifactPageSchema,
  ReleaseBoardSchema,
  ReleaseConfigSchema,
  ReleaseCrcrSchema,
  ReleaseIndexSchema,
  ReleaseMilestoneItemsSchema,
} from "lib/api/releases/types";
import { ErrorResponseSchema } from "lib/api/schema";
import * as githubAuth from "lib/auth/githubAuth";
import { queryClickhouse } from "lib/clickhouse";
import { callRoute } from "../routes";
import { committedFetch } from "./fixtures";

jest.mock("lib/clickhouse", () => ({ queryClickhouse: jest.fn() }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

const query = queryClickhouse as jest.Mock;

function stateRow(
  release: string,
  step_id: string,
  extra: Record<string, unknown> = {}
) {
  return {
    release,
    step_id,
    rc: "",
    status: "done",
    blocking: 0,
    evidence_text: "ok",
    evidence_url: "",
    last_checked: "2026-12-01 10:00:00.000",
    ...extra,
  };
}

beforeEach(() => {
  clearConfigCache();
  query.mockReset();
  query.mockResolvedValue([]);
  global.fetch = committedFetch() as unknown as typeof fetch;
});

describe("GET /api/releases", () => {
  test("lists the releases the collector has written for, newest first, and who is active", async () => {
    query.mockResolvedValue([
      stateRow("2.15.1", "1.2", { status: "in_progress" }),
      stateRow("2.16.0", "1.1", { status: "done" }),
      stateRow("2.16.0", "1.2", { status: "blocked", blocking: 1 }),
    ]);
    const { status, body, headers } = await callRoute(
      getIndex,
      "/api/releases"
    );
    expect(status).toBe(200);
    expect(ReleaseIndexSchema.parse(body)).toEqual(body);
    expect(body.releases.map((r: any) => r.version)).toEqual([
      "2.16.0",
      "2.15.1",
    ]);
    expect(body.active.map((a: any) => a.version)).toEqual([
      "2.16.0",
      "2.15.1",
    ]);
    expect(body.releases[0]).toMatchObject({
      type: "minor",
      ga_date: "2026-12-17",
      status: "blocked",
    });
    expect(body.releases[1]).toMatchObject({
      type: "patch",
      ga_date: null,
      status: "in_progress",
    });
    expect(body.releases[1].progress.total).toBe(35);
    expect(headers.get("Cache-Control")).toMatch(/^public, /);
  });

  test("no releases recorded yet is an empty list, not an error", async () => {
    const { status, body } = await callRoute(getIndex, "/api/releases");
    expect(status).toBe(200);
    expect(body).toEqual({
      active: [],
      releases: [],
      pagination: { next: null, previous: null },
    });
  });

  test("a release whose config does not parse is left out of the index", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    global.fetch = committedFetch({
      "releases/2.15.1.yml": "release: [not, a, string]\n",
    }) as unknown as typeof fetch;
    query.mockResolvedValue([
      stateRow("2.16.0", "1.1"),
      stateRow("2.15.1", "1.2"),
    ]);
    const { status, body } = await callRoute(getIndex, "/api/releases");
    expect(status).toBe(200);
    expect(body.releases.map((r: any) => r.version)).toEqual(["2.16.0"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("rejects a parameter", async () => {
    const { status, body } = await callRoute(getIndex, "/api/releases", {
      limit: "5",
    });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_parameters");
  });

  test("a failed query is a 500 that gives nothing away", async () => {
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    query.mockRejectedValue(
      new Error("connection refused: clickhouse.internal:8443")
    );
    const { status, body } = await callRoute(getIndex, "/api/releases");
    expect(status).toBe(500);
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("clickhouse.internal");
    error.mockRestore();
  });
});

describe("GET /api/releases/{version}", () => {
  test("answers a release's board", async () => {
    query.mockResolvedValue([
      stateRow("2.16.0", "1.2", {
        status: "blocked",
        blocking: 1,
        evidence_text: "3 outstanding",
        evidence_url: "https://github.com/pytorch/pytorch/milestone/71",
      }),
      stateRow("2.16.0", "2.1", { rc: "rc1", status: "in_progress" }),
    ]);
    const { status, body, headers } = await callRoute(
      getBoard,
      "/api/releases/{version}",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(ReleaseBoardSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({ version: "2.16.0", current_rc: "rc1" });
    expect(body.stats.blocking).toBe(1);
    expect(body.links.milestone).toBe(
      "https://github.com/pytorch/pytorch/milestone/71"
    );
    expect(body.links.tracker_issue).toBeNull();
    expect(headers.get("Cache-Control")).toMatch(/^public, /);
    expect(query.mock.calls[0][1]).toEqual({ release: "2.16.0" });
  });

  test("a release the portal does not know is a 404", async () => {
    const { status, body } = await callRoute(
      getBoard,
      "/api/releases/{version}",
      { version: "2.99.0" }
    );
    expect(status).toBe(404);
    expect(body).toEqual({
      error: "The portal has no release 2.99.0",
      code: "not_found",
    });
  });

  test("a release with state but no file of its own is drawn from the shared steps", async () => {
    query.mockResolvedValue([stateRow("2.99.0", "1.2")]);
    const { status, body } = await callRoute(
      getBoard,
      "/api/releases/{version}",
      { version: "2.99.0" }
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      version: "2.99.0",
      type: "minor",
      branch: "release/2.99",
    });
  });

  test("a malformed version, or an unknown parameter, is a 400", async () => {
    for (const q of [
      { version: "2.16" },
      { version: "latest" },
      { version: "2.16.0", sort: "x" },
    ]) {
      const { status, body } = await callRoute(
        getBoard,
        "/api/releases/{version}",
        q
      );
      expect({ q, status, code: body.code }).toEqual({
        q,
        status: 400,
        code: "invalid_parameters",
      });
    }
  });
});

describe("GET /api/releases/{version}/config", () => {
  test("answers the resolved config", async () => {
    query.mockResolvedValue([stateRow("2.15.1", "1.2")]);
    const { status, body } = await callRoute(
      getConfig,
      "/api/releases/{version}/config",
      { version: "2.15.1" }
    );
    expect(status).toBe(200);
    expect(ReleaseConfigSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      release: "2.15.1",
      type: "patch",
      branch: "release/2.15",
    });
    expect(body.steps).toHaveLength(35);
  });

  test("a release with a file of its own has a config before any state exists", async () => {
    const { status, body } = await callRoute(
      getConfig,
      "/api/releases/{version}/config",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(body.dates.ga).toBe("2026-12-17");
  });

  test("an unknown release is a 404 and a bad version a 400", async () => {
    expect(
      (
        await callRoute(getConfig, "/api/releases/{version}/config", {
          version: "2.99.0",
        })
      ).status
    ).toBe(404);
    expect(
      (
        await callRoute(getConfig, "/api/releases/{version}/config", {
          version: "x",
        })
      ).status
    ).toBe(400);
  });
});

describe("GET /api/releases/{version}/artifacts", () => {
  const artifactRow = {
    channel: "test",
    rc: "rc2",
    package_type: "wheel",
    project: "torch",
    accelerator: "cu130",
    python: "3.14",
    os: "linux",
    arch: "x86_64",
    verdict: "missing",
    expected_url: "https://download.pytorch.org/whl/test/x.whl",
    observed_url: "",
    http_status: 404,
    size_bytes: null,
    vs_previous_pct: null,
    verdict_rank: 0,
  };

  function answer(rows: unknown[]) {
    query.mockImplementation(async (sql: string) =>
      sql.includes("toUInt32OrZero")
        ? [{ rc: "rc2" }]
        : sql.includes("GROUP BY verdict")
        ? [{ verdict: "missing", artifacts: "1" }]
        : rows
    );
  }

  test("answers the counts, the rows and the pagination", async () => {
    answer([artifactRow]);
    const { status, body, headers } = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      {
        version: "2.16.0",
        channel: "test",
        package: "wheel",
      }
    );
    expect(status).toBe(200);
    expect(ArtifactPageSchema.parse(body)).toEqual(body);
    expect(body.rc).toBe("rc2");
    expect(body.summary).toEqual({
      expected: 1,
      present: 0,
      missing: 1,
      size_anomalous: 0,
      unexpected: 0,
    });
    expect(body.rows).toHaveLength(1);
    expect(body.pagination).toEqual({ next: null, previous: null });
    expect(headers.get("Cache-Control")).toMatch(/^public, /);
  });

  test("builds the next link from the request, keeping the filters", async () => {
    answer([
      artifactRow,
      { ...artifactRow, accelerator: "cu132" },
      { ...artifactRow, accelerator: "rocm7.1" },
    ]);
    const { body } = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      {
        version: "2.16.0",
        os: "linux",
        limit: "2",
      }
    );
    expect(body.rows).toHaveLength(2);
    expect(body.pagination.next.url).toMatch(
      /^\/api\/releases\/2\.16\.0\/artifacts\?os=linux&limit=2&cursor=/
    );
    // following it with the same filters is accepted
    const followed = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      {
        version: "2.16.0",
        os: "linux",
        limit: "2",
        cursor: body.pagination.next.cursor,
      }
    );
    expect(followed.status).toBe(200);
  });

  test("rejects bad parameters with every issue", async () => {
    const { status, body } = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      {
        version: "2.16.0",
        channel: "nightly",
        limit: "0",
        colour: "red",
      }
    );
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_parameters");
    expect(body.issues.map((i: any) => i.path[0]).sort()).toEqual([
      "channel",
      "colour",
      "limit",
    ]);
  });

  test("rejects a cursor it did not issue, and one issued for a different query", async () => {
    query.mockRejectedValue(new Error("ClickHouse is unavailable"));
    const garbage = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      {
        version: "2.16.0",
        cursor: "garbage",
      }
    );
    expect(garbage.status).toBe(400);
    expect(garbage.body.code).toBe("invalid_cursor");
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue([]);
    const cursor = encodeArtifactCursor({
      version: 1,
      resource: "release-artifacts",
      direction: "next",
      query: { version: "2.16.0" },
      position: { values: [0, "a", "b", "c", "d", "e", "f", "g"] },
    });
    const mismatch = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      {
        version: "2.16.0",
        os: "linux",
        cursor,
      }
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("cursor_query_mismatch");
  });

  test("a release with no artifacts yet answers zero counts, not a 404", async () => {
    const { status, body } = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      {
        version: "2.16.0",
      }
    );
    expect(status).toBe(200);
    expect(body.summary.expected).toBe(0);
    expect(body.rows).toEqual([]);
  });

  test("an unknown release is a 404 before listing artifacts", async () => {
    const { status, body } = await callRoute(
      getArtifacts,
      "/api/releases/{version}/artifacts",
      { version: "2.99.0" }
    );
    expect(status).toBe(404);
    expect(body).toEqual({
      error: "The portal has no release 2.99.0",
      code: "not_found",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/releases/{version}/milestone", () => {
  const details = JSON.stringify({
    milestone: 71,
    branch: "release/2.16",
    branch_cut: true,
    issues: 3,
    by_reason: { open: 1, on_release_branch: 1, not_on_release_branch: 1 },
    outstanding: [
      {
        number: 123,
        kind: "issue",
        title: "Open release issue",
        url: "https://github.com/pytorch/pytorch/issues/123",
        state: "open",
        reason: "open",
      },
      {
        number: 456,
        kind: "pull_request",
        title: "Closed but missing from branch",
        url: "https://github.com/pytorch/pytorch/pull/456",
        state: "closed",
        reason: "not_on_release_branch",
      },
    ],
  });

  function answerMilestone(detailsValue: string | null) {
    query.mockImplementation(async (sql: string) =>
      sql.includes("check_type = 'milestone_outstanding_items'")
        ? detailsValue === null
          ? []
          : [
              {
                details: detailsValue,
                last_checked: "2026-12-01 10:00:00.000",
              },
            ]
        : [stateRow("2.16.0", "1.2")]
    );
  }

  test("returns the latest collector detail with its observed time", async () => {
    answerMilestone(details);
    const { status, body, headers } = await callRoute(
      getMilestone,
      "/api/releases/{version}/milestone",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(ReleaseMilestoneItemsSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      version: "2.16.0",
      milestone: 71,
      branch: "release/2.16",
      outstanding: [
        { number: 123, reason: "open" },
        { number: 456, reason: "not_on_release_branch" },
      ],
      last_checked: "2026-12-01T10:00:00.000Z",
    });
    expect(headers.get("Cache-Control")).toMatch(/^public, /);
  });

  test("distinguishes an unscanned milestone from an empty one", async () => {
    answerMilestone(null);
    const { status, body } = await callRoute(
      getMilestone,
      "/api/releases/{version}/milestone",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      version: "2.16.0",
      milestone: null,
      branch: "release/2.16",
      branch_cut: null,
      issues: null,
      by_reason: {},
      outstanding: [],
      last_checked: null,
    });
  });

  test("does not expose malformed collector details", async () => {
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    answerMilestone("not JSON");
    const { status, body } = await callRoute(
      getMilestone,
      "/api/releases/{version}/milestone",
      { version: "2.16.0" }
    );
    expect(status).toBe(500);
    expect(body.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("not JSON");
    error.mockRestore();
  });
});

describe("GET /api/releases/{version}/crcr", () => {
  function repoResult(extra: Record<string, unknown> = {}) {
    return {
      repo: "vllm-project/vllm",
      level: "L2",
      rc: "rc9",
      result: "failed",
      summary: "3 of 212 jobs failed",
      failing_jobs: [
        {
          name: "Compile Unit Tests",
          url: "https://github.com/vllm-project/vllm/actions/runs/1/job/2",
        },
      ],
      owner: "vLLM CI oncall",
      run_url: "https://github.com/vllm-project/vllm/actions/runs/1",
      finished_at: "2026-10-29T10:12:00Z",
      ...extra,
    };
  }

  function answerCrcr(row: { rc: string; details: string } | null) {
    query.mockImplementation(async (sql: string) =>
      sql.includes("check_type = 'crcr_summary'")
        ? row === null
          ? []
          : [row]
        : [stateRow("2.16.0", "1.2")]
    );
  }

  const passed = (repo: string, extra: Record<string, unknown> = {}) =>
    repoResult({
      repo,
      result: "passed",
      summary: "212 of 212 jobs passed",
      failing_jobs: [],
      ...extra,
    });

  test("answers the newest release candidate's results, failed repos first, with counts", async () => {
    answerCrcr({
      rc: "rc9",
      details: JSON.stringify({
        repos: [
          passed("sgl-project/sglang"),
          repoResult(),
          passed("Ascend/pytorch"),
        ],
      }),
    });
    const { status, body, headers } = await callRoute(
      getCrcr,
      "/api/releases/{version}/crcr",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(ReleaseCrcrSchema.parse(body)).toEqual(body);
    expect(body.rc).toBe("rc9");
    expect(body.summary).toEqual({
      repos: 3,
      passing: 2,
      failing: 1,
      no_result: 0,
    });
    expect(body.repos.map((r: any) => r.repo)).toEqual([
      "vllm-project/vllm",
      "Ascend/pytorch",
      "sgl-project/sglang",
    ]);
    expect(body.repos[0]).toMatchObject({
      level: "L2",
      rc: "rc9",
      result: "failed",
      summary: "3 of 212 jobs failed",
      failing_jobs: [
        {
          name: "Compile Unit Tests",
          url: "https://github.com/vllm-project/vllm/actions/runs/1/job/2",
        },
      ],
      owner: "vLLM CI oncall",
      finished_at: "2026-10-29T10:12:00Z",
      hud_url:
        "https://hud.pytorch.org/crcr/vllm-project/vllm?event=release&version=2.16.0",
    });
    expect(headers.get("Cache-Control")).toMatch(/^public, /);
    const crcrCall = query.mock.calls.find(([sql]) =>
      sql.includes("check_type = 'crcr_summary'")
    );
    expect(crcrCall?.[1]).toEqual({ release: "2.16.0" });
  });

  test("keeps what the repo did not report as null", async () => {
    answerCrcr({
      rc: "rc9",
      details: JSON.stringify({
        repos: [
          repoResult({
            owner: null,
            run_url: null,
            failing_jobs: [{ name: "Compile Unit Tests", url: null }],
          }),
        ],
      }),
    });
    const { status, body } = await callRoute(
      getCrcr,
      "/api/releases/{version}/crcr",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(ReleaseCrcrSchema.parse(body)).toEqual(body);
    expect(body.repos[0]).toMatchObject({
      owner: null,
      run_url: null,
      failing_jobs: [{ name: "Compile Unit Tests", url: null }],
    });
  });

  test("lists an opted-in repo with no result, after the failed repos and before the passed", async () => {
    const silent = (repo: string) =>
      repoResult({
        repo,
        result: "no_result",
        summary: "No result reported for rc9",
        failing_jobs: [],
        run_url: null,
        finished_at: null,
      });
    answerCrcr({
      rc: "rc9",
      details: JSON.stringify({
        repos: [
          passed("sgl-project/sglang"),
          silent("Ascend/pytorch"),
          repoResult(),
          silent("AMD/rocm"),
        ],
      }),
    });
    const { status, body } = await callRoute(
      getCrcr,
      "/api/releases/{version}/crcr",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(ReleaseCrcrSchema.parse(body)).toEqual(body);
    expect(body.summary).toEqual({
      repos: 4,
      passing: 1,
      failing: 1,
      no_result: 2,
    });
    expect(body.repos.map((r: any) => [r.repo, r.result])).toEqual([
      ["vllm-project/vllm", "failed"],
      ["AMD/rocm", "no_result"],
      ["Ascend/pytorch", "no_result"],
      ["sgl-project/sglang", "passed"],
    ]);
    expect(body.repos[2]).toMatchObject({
      level: "L2",
      rc: "rc9",
      result: "no_result",
      summary: "No result reported for rc9",
      failing_jobs: [],
      run_url: null,
      finished_at: null,
      hud_url:
        "https://hud.pytorch.org/crcr/Ascend/pytorch?event=release&version=2.16.0",
    });
  });

  test("a release candidate no repo has reported for yet has an rc and no repos", async () => {
    answerCrcr({ rc: "rc10", details: "" });
    const { status, body } = await callRoute(
      getCrcr,
      "/api/releases/{version}/crcr",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(ReleaseCrcrSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      rc: "rc10",
      summary: { repos: 0, passing: 0, failing: 0, no_result: 0 },
      repos: [],
    });
  });

  test("a release with no recorded results answers a null rc and zero counts, not a 404", async () => {
    answerCrcr(null);
    const { status, body } = await callRoute(
      getCrcr,
      "/api/releases/{version}/crcr",
      { version: "2.16.0" }
    );
    expect(status).toBe(200);
    expect(ReleaseCrcrSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      rc: null,
      summary: { repos: 0, passing: 0, failing: 0, no_result: 0 },
      repos: [],
    });
  });

  test("links a repo to the HUD the API itself is served from", async () => {
    const before = process.env.HUD_SELF_URL;
    process.env.HUD_SELF_URL = "https://hud.example.test";
    try {
      answerCrcr({
        rc: "rc9",
        details: JSON.stringify({ repos: [repoResult()] }),
      });
      const { body } = await callRoute(
        getCrcr,
        "/api/releases/{version}/crcr",
        { version: "2.16.0" }
      );
      expect(body.repos[0].hud_url).toBe(
        "https://hud.example.test/crcr/vllm-project/vllm?event=release&version=2.16.0"
      );
    } finally {
      if (before === undefined) delete process.env.HUD_SELF_URL;
      else process.env.HUD_SELF_URL = before;
    }
  });

  test("an unknown release is a 404 and a bad version, or a parameter, a 400", async () => {
    const unknown = await callRoute(getCrcr, "/api/releases/{version}/crcr", {
      version: "2.99.0",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({
      error: "The portal has no release 2.99.0",
      code: "not_found",
    });
    for (const q of [{ version: "latest" }, { version: "2.16.0", rc: "rc9" }]) {
      const { status, body } = await callRoute(
        getCrcr,
        "/api/releases/{version}/crcr",
        q
      );
      expect({ q, status, code: body.code }).toEqual({
        q,
        status: 400,
        code: "invalid_parameters",
      });
    }
  });

  test("does not expose malformed collector details", async () => {
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    for (const details of [
      "not JSON",
      JSON.stringify({ repos: [repoResult({ result: "running" })] }),
      JSON.stringify({ repos: [repoResult({ repo: "../../admin" })] }),
      JSON.stringify({ repos: [repoResult({ level: "L1" })] }),
    ]) {
      answerCrcr({ rc: "rc9", details });
      const { status, body } = await callRoute(
        getCrcr,
        "/api/releases/{version}/crcr",
        { version: "2.16.0" }
      );
      expect({ details, status, code: body.code }).toEqual({
        details,
        status: 500,
        code: "internal_error",
      });
      expect(JSON.stringify(body)).not.toContain("admin");
      expect(JSON.stringify(body)).not.toContain("not JSON");
    }
    error.mockRestore();
  });

  test("a failed query is a 500 that gives nothing away", async () => {
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    query.mockRejectedValue(
      new Error("connection refused: clickhouse.internal:8443")
    );
    const { status, body } = await callRoute(
      getCrcr,
      "/api/releases/{version}/crcr",
      { version: "2.16.0" }
    );
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("clickhouse.internal");
    error.mockRestore();
  });
});

describe("public access", () => {
  test("none of the endpoints asks for a credential or the GitHub gate", async () => {
    const authorize = jest.spyOn(githubAuth, "authorizeGithubToken");
    query.mockImplementation(async (sql: string) =>
      sql.includes("check_type = 'milestone_outstanding_items'") ||
      sql.includes("check_type = 'crcr_summary'")
        ? []
        : [stateRow("2.16.0", "1.1")]
    );
    const calls = [
      callRoute(getIndex, "/api/releases"),
      callRoute(getBoard, "/api/releases/{version}", { version: "2.16.0" }),
      callRoute(getConfig, "/api/releases/{version}/config", {
        version: "2.16.0",
      }),
      callRoute(getArtifacts, "/api/releases/{version}/artifacts", {
        version: "2.16.0",
      }),
      callRoute(getMilestone, "/api/releases/{version}/milestone", {
        version: "2.16.0",
      }),
      callRoute(getCrcr, "/api/releases/{version}/crcr", {
        version: "2.16.0",
      }),
    ];
    for (const { status, headers } of await Promise.all(calls)) {
      expect(status).toBe(200);
      expect(headers.get("WWW-Authenticate")).toBeNull();
      expect(headers.get("Cache-Control")).toMatch(/^public, /);
    }
    expect(authorize).not.toHaveBeenCalled();
    authorize.mockRestore();
  });

  test("an error is never kept by a shared cache", async () => {
    for (const { headers } of [
      await callRoute(getBoard, "/api/releases/{version}", {
        version: "2.99.0",
      }),
      await callRoute(getBoard, "/api/releases/{version}", { version: "bad" }),
    ]) {
      expect(headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
