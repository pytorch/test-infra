import {
  ARTIFACT_SEEK_KEYS,
  buildArtifactsQuery,
  buildArtifactSummaryQuery,
  listArtifacts,
} from "lib/api/releases/artifacts";
import {
  artifactCursorMatchesQuery,
  decodeArtifactCursor,
  encodeArtifactCursor,
} from "lib/api/releases/cursor";
import {
  ArtifactQuery,
  ArtifactQuerySchema,
} from "lib/api/releases/parameters";
import { ArtifactPageSchema } from "lib/api/releases/types";
import { queryClickhouse } from "lib/clickhouse";

jest.mock("lib/clickhouse", () => ({ queryClickhouse: jest.fn() }));
const query = queryClickhouse as jest.Mock;

function artifactQuery(extra: Partial<ArtifactQuery> = {}): ArtifactQuery {
  return ArtifactQuerySchema.parse({ version: "2.16.0", ...extra });
}

function dbRow(extra: Record<string, unknown> = {}) {
  return {
    channel: "test",
    package_type: "wheel",
    project: "torch",
    accelerator: "cu130",
    python: "3.14",
    os: "linux",
    arch: "x86_64",
    verdict: "present",
    expected_url:
      "https://download.pytorch.org/whl/test/cu130/torch-2.16.0-cp314.whl",
    observed_url:
      "https://download.pytorch.org/whl/test/cu130/torch-2.16.0-cp314.whl",
    http_status: 200,
    size_bytes: "600000000",
    vs_previous_pct: 1.5,
    verdict_rank: 3,
    ...extra,
  };
}

describe("the artifact page query", () => {
  test("reads the latest observation of each artifact of the release", () => {
    const { sql, params } = buildArtifactsQuery(artifactQuery(), null, 50);
    expect(sql).toContain("misc.release_artifact_observation");
    expect(sql).toContain("ORDER BY observed_at DESC");
    expect(sql).toContain(
      "LIMIT 1 BY channel, package_type, project, accelerator, python, os, arch"
    );
    expect(params).toMatchObject({ release: "2.16.0", entries_limit: 51 });
    expect(sql).not.toContain("{channel");
  });

  test("filters by channel, package and os, and by verdict outside the latest-row read", () => {
    const { sql, params } = buildArtifactsQuery(
      artifactQuery({
        channel: "test",
        package: "wheel",
        os: "linux",
        verdict: "missing",
      }),
      null,
      10
    );
    expect(sql).toContain("channel = {channel: String}");
    expect(sql).toContain("package_type = {package: String}");
    expect(sql).toContain("os = {os: String}");
    expect(sql).toContain("verdict = {verdict: String}");
    expect(params).toMatchObject({
      channel: "test",
      package: "wheel",
      os: "linux",
      verdict: "missing",
    });
    // the verdict narrows the rows of the latest read, so it comes after it
    expect(sql.indexOf("verdict = {verdict: String}")).toBeGreaterThan(
      sql.indexOf("LIMIT 1 BY")
    );
  });

  test("lists problems first and breaks ties by the artifact's coordinates", () => {
    expect(ARTIFACT_SEEK_KEYS.map((k) => k.column)).toEqual([
      "verdict_rank",
      "channel",
      "package_type",
      "project",
      "accelerator",
      "python",
      "os",
      "arch",
    ]);
    const { sql } = buildArtifactsQuery(artifactQuery(), null, 5);
    expect(sql).toContain(
      "multiIf(verdict = 'missing', 0, verdict = 'size_anomalous', 1, verdict = 'unexpected', 2, 3)"
    );
    expect(sql).toContain(
      "ORDER BY verdict_rank ASC, channel ASC, package_type ASC"
    );
  });

  test("seeks past the cursor's position, and reverses for a previous page", () => {
    const position = {
      values: [
        0,
        "test",
        "wheel",
        "torch",
        "cu130",
        "3.14",
        "linux",
        "x86_64",
      ] as any,
    };
    const base = {
      version: 1 as const,
      resource: "release-artifacts" as const,
      query: { version: "2.16.0" },
      position,
    };
    const next = buildArtifactsQuery(
      artifactQuery(),
      { ...base, direction: "next" } as any,
      5
    );
    expect(next.sql).toContain("verdict_rank > {cursor_0: UInt8}");
    expect(next.params).toMatchObject({
      cursor_0: 0,
      cursor_1: "test",
      cursor_7: "x86_64",
    });
    const previous = buildArtifactsQuery(
      artifactQuery(),
      { ...base, direction: "previous" } as any,
      5
    );
    expect(previous.sql).toContain("verdict_rank < {cursor_0: UInt8}");
    expect(previous.sql).toContain("ORDER BY verdict_rank DESC, channel DESC");
  });

  test("the summary counts the latest observation of every artifact that matches channel, package and os", () => {
    const { sql, params } = buildArtifactSummaryQuery(
      artifactQuery({ channel: "release", verdict: "missing", limit: 5 })
    );
    expect(sql).toContain("GROUP BY verdict");
    expect(sql).toContain("channel = {channel: String}");
    expect(sql).not.toContain("{verdict");
    expect(params).toEqual({ release: "2.16.0", channel: "release" });
  });
});

describe("cursors", () => {
  const cursor = {
    version: 1 as const,
    resource: "release-artifacts" as const,
    direction: "next" as const,
    query: { version: "2.16.0" },
    position: {
      values: [
        0,
        "test",
        "wheel",
        "torch",
        "cu130",
        "3.14",
        "linux",
        "x86_64",
      ] as any,
    },
  };

  test("round-trip and bind the query except the page size", () => {
    const decoded = decodeArtifactCursor(encodeArtifactCursor(cursor));
    expect(decoded).toEqual(cursor);
    expect(
      artifactCursorMatchesQuery(decoded!, artifactQuery({ limit: 7 }))
    ).toBe(true);
    expect(
      artifactCursorMatchesQuery(decoded!, artifactQuery({ channel: "test" }))
    ).toBe(false);
    expect(
      artifactCursorMatchesQuery(
        decoded!,
        ArtifactQuerySchema.parse({ version: "2.15.1" })
      )
    ).toBe(false);
  });

  test("a token that does not decode, or is not for this resource, is null", () => {
    expect(decodeArtifactCursor("not a token")).toBeNull();
    expect(
      decodeArtifactCursor(Buffer.from("{}").toString("base64url"))
    ).toBeNull();
    const other = Buffer.from(
      JSON.stringify({ ...cursor, resource: "commit-runs" })
    ).toString("base64url");
    expect(decodeArtifactCursor(other)).toBeNull();
    const short = Buffer.from(
      JSON.stringify({ ...cursor, position: { values: [0, "test"] } })
    ).toString("base64url");
    expect(decodeArtifactCursor(short)).toBeNull();
  });
});

describe("listArtifacts", () => {
  beforeEach(() => query.mockReset());

  function answer(rows: any[], summary: any[] = []) {
    query.mockImplementation(async (sql: string) =>
      sql.includes("GROUP BY verdict") ? summary : rows
    );
  }

  test("answers the counts and the rows in the response schema", async () => {
    answer(
      [
        dbRow({
          verdict: "missing",
          verdict_rank: 0,
          http_status: 404,
          size_bytes: null,
          vs_previous_pct: null,
          observed_url: "",
        }),
        dbRow({ accelerator: "cpu" }),
      ],
      [
        { verdict: "present", artifacts: "81" },
        { verdict: "missing", artifacts: "2" },
        { verdict: "size_anomalous", artifacts: "1" },
      ]
    );
    const page = await listArtifacts({ query: artifactQuery(), cursor: null });
    const { next_cursor, previous_cursor, ...body } = page;
    expect(next_cursor).toBeNull();
    expect(previous_cursor).toBeNull();
    expect(
      ArtifactPageSchema.parse({
        ...body,
        pagination: { next: null, previous: null },
      })
    ).toBeTruthy();
    expect(body.summary).toEqual({
      expected: 84,
      present: 81,
      missing: 2,
      size_anomalous: 1,
      unexpected: 0,
    });
    expect(body.rows[0]).toEqual({
      package: "wheel",
      project: "torch",
      channel: "test",
      accelerator: "cu130",
      python: "3.14",
      os: "linux",
      arch: "x86_64",
      verdict: "missing",
      size_bytes: null,
      vs_previous_pct: null,
      // a missing artifact is evidenced by where it was expected
      evidence: {
        url: "https://download.pytorch.org/whl/test/cu130/torch-2.16.0-cp314.whl",
        http_status: 404,
      },
    });
    expect(body.rows[1]).toMatchObject({
      size_bytes: 600000000,
      vs_previous_pct: 1.5,
      verdict: "present",
    });
  });

  test("an empty release answers zero counts and no rows", async () => {
    answer([], []);
    const page = await listArtifacts({ query: artifactQuery(), cursor: null });
    expect(page.summary).toEqual({
      expected: 0,
      present: 0,
      missing: 0,
      size_anomalous: 0,
      unexpected: 0,
    });
    expect(page.rows).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  test("a full page has a next cursor at its last row, and none before the first page", async () => {
    const rows = [
      dbRow({ accelerator: "cpu", verdict_rank: 3 }),
      dbRow({ accelerator: "cu130", verdict_rank: 3 }),
      dbRow({ accelerator: "cu132", verdict_rank: 3 }),
    ];
    answer(rows);
    const page = await listArtifacts({
      query: artifactQuery({ limit: 2 }),
      cursor: null,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.previous_cursor).toBeNull();
    const next = decodeArtifactCursor(page.next_cursor!);
    expect(next).toMatchObject({
      direction: "next",
      resource: "release-artifacts",
      query: { version: "2.16.0" },
      position: {
        values: [
          3,
          "test",
          "wheel",
          "torch",
          "cu130",
          "3.14",
          "linux",
          "x86_64",
        ],
      },
    });
  });

  test("a later page probes the other direction for a previous cursor", async () => {
    const cursor = decodeArtifactCursor(
      encodeArtifactCursor({
        version: 1,
        resource: "release-artifacts",
        direction: "next",
        query: { version: "2.16.0" },
        position: {
          values: [
            3,
            "test",
            "wheel",
            "torch",
            "cu130",
            "3.14",
            "linux",
            "x86_64",
          ],
        },
      })
    );
    answer([dbRow({ accelerator: "cu132" })]);
    const page = await listArtifacts({
      query: artifactQuery({ limit: 2 }),
      cursor,
    });
    expect(page.next_cursor).toBeNull();
    expect(decodeArtifactCursor(page.previous_cursor!)).toMatchObject({
      direction: "previous",
    });
  });
});
