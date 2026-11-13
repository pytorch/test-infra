import { GET as getArtifacts } from "app/api/releases/[version]/artifacts/route";
import { GET as getConfig } from "app/api/releases/[version]/config/route";
import { GET as getBoard } from "app/api/releases/[version]/route";
import { GET as getIndex } from "app/api/releases/route";
import { clearConfigCache } from "lib/api/releases/config";
import { encodeArtifactCursor } from "lib/api/releases/cursor";
import {
  ArtifactPageSchema,
  ReleaseBoardSchema,
  ReleaseConfigSchema,
  ReleaseIndexSchema,
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
    expect(body.releases[1].progress.total).toBe(34);
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
    expect(body.steps).toHaveLength(34);
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

describe("public access", () => {
  test("none of the endpoints asks for a credential or the GitHub gate", async () => {
    const authorize = jest.spyOn(githubAuth, "authorizeGithubToken");
    query.mockResolvedValue([stateRow("2.16.0", "1.1")]);
    const calls = [
      callRoute(getIndex, "/api/releases"),
      callRoute(getBoard, "/api/releases/{version}", { version: "2.16.0" }),
      callRoute(getConfig, "/api/releases/{version}/config", {
        version: "2.16.0",
      }),
      callRoute(getArtifacts, "/api/releases/{version}/artifacts", {
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
