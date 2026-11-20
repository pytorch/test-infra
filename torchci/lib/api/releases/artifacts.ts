import { queryPage } from "lib/api/pagination";
import {
  ArtifactCursor,
  artifactIdentity,
  encodeArtifactCursor,
} from "lib/api/releases/cursor";
import { RELEASE_DATABASE } from "lib/api/releases/database";
import type { ArtifactQuery } from "lib/api/releases/parameters";
import type { ArtifactPage, ArtifactRow } from "lib/api/releases/types";
import type { ListPageData } from "lib/api/schema";
import { SeekKey, seekOrderBy, seekPredicate } from "lib/api/seek";
import { queryClickhouse } from "lib/clickhouse";

// A release's artifacts as the collector last saw them: the latest row of
// release_artifact_observation for each artifact. Problems come first: missing, then
// size_anomalous, then unexpected, then present, and the artifact's coordinates break
// the ties, so a page boundary is a stable position.

export const ARTIFACT_SEEK_KEYS: SeekKey[] = [
  {
    column: "verdict_rank",
    parameterType: "UInt8",
    direction: "ASC",
    nullable: false,
  },
  {
    column: "channel",
    parameterType: "String",
    direction: "ASC",
    nullable: false,
  },
  {
    column: "package_type",
    parameterType: "String",
    direction: "ASC",
    nullable: false,
  },
  {
    column: "project",
    parameterType: "String",
    direction: "ASC",
    nullable: false,
  },
  {
    column: "accelerator",
    parameterType: "String",
    direction: "ASC",
    nullable: false,
  },
  {
    column: "python",
    parameterType: "String",
    direction: "ASC",
    nullable: false,
  },
  { column: "os", parameterType: "String", direction: "ASC", nullable: false },
  {
    column: "arch",
    parameterType: "String",
    direction: "ASC",
    nullable: false,
  },
];

// The latest observation of each artifact of the release that matches channel, package
// and os, among the observations of one release candidate when query.rc is set (the
// release channel has no release candidate, so its rows always match). LIMIT 1 BY keeps
// the whole row, NULLs included, which argMax would skip.
function latest(query: ArtifactQuery, params: Record<string, unknown>): string {
  const filters = ["release = {release: String}"];
  params.release = query.version;
  for (const [name, column] of [
    ["channel", "channel"],
    ["package", "package_type"],
    ["os", "os"],
  ] as const) {
    const value = query[name];
    if (value !== undefined) {
      filters.push(`${column} = {${name}: String}`);
      params[name] = value;
    }
  }
  if (query.rc !== undefined) {
    filters.push("(rc = '' OR rc = {rc: String})");
    params.rc = query.rc;
  }
  return `
SELECT
    channel, rc, package_type, project, accelerator, python, os, arch,
    toString(verdict) AS verdict,
    expected_url, observed_url, http_status, size_bytes, vs_previous_pct
FROM ${RELEASE_DATABASE}.release_artifact_observation
WHERE ${filters.join(" AND ")}
ORDER BY observed_at DESC
LIMIT 1 BY channel, package_type, project, accelerator, python, os, arch`;
}

export function buildArtifactsQuery(
  query: ArtifactQuery,
  cursor: ArtifactCursor | null,
  limit: number
) {
  const params: Record<string, unknown> = {};
  const inner = latest(query, params);
  let verdictFilter = "1";
  if (query.verdict !== undefined) {
    verdictFilter = "verdict = {verdict: String}";
    params.verdict = query.verdict;
  }
  const seek = seekPredicate(ARTIFACT_SEEK_KEYS, cursor, params);
  params.entries_limit = limit + 1;
  const sql = `
SELECT *
FROM (
    SELECT
        *,
        multiIf(verdict = 'missing', 0, verdict = 'size_anomalous', 1, verdict = 'unexpected', 2, 3) AS verdict_rank
    FROM (${inner})
)
WHERE ${verdictFilter} AND (${seek})
ORDER BY ${seekOrderBy(ARTIFACT_SEEK_KEYS, cursor?.direction === "previous")}
LIMIT {entries_limit: UInt64}`;
  return { sql, params };
}

export function buildArtifactSummaryQuery(query: ArtifactQuery) {
  const params: Record<string, unknown> = {};
  const inner = latest(query, params);
  return {
    sql: `
SELECT verdict, count() AS artifacts
FROM (${inner})
GROUP BY verdict`,
    params,
  };
}

// The newest release candidate that has observations, as the board's current_rc is the
// newest one that has a step state: by number, so rc10 follows rc9.
export function buildNewestRcQuery(version: string) {
  return {
    sql: `
SELECT rc
FROM ${RELEASE_DATABASE}.release_artifact_observation
WHERE release = {release: String} AND rc != ''
GROUP BY rc
ORDER BY toUInt32OrZero(replaceRegexpOne(rc, '^rc', '')) DESC
LIMIT 1`,
    params: { release: version },
  };
}

interface ArtifactDbRow {
  channel: string;
  rc: string;
  package_type: string;
  project: string;
  accelerator: string;
  python: string;
  os: string;
  arch: string;
  verdict: ArtifactRow["verdict"];
  expected_url: string;
  observed_url: string;
  http_status: number | null;
  size_bytes: number | string | null;
  vs_previous_pct: number | null;
  verdict_rank: number;
}

function toRow(row: ArtifactDbRow): ArtifactRow {
  return {
    package: row.package_type,
    project: row.project,
    channel: row.channel,
    rc: row.rc === "" ? null : row.rc,
    accelerator: row.accelerator,
    python: row.python,
    os: row.os,
    arch: row.arch,
    verdict: row.verdict,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    // The column is Float32, which reaches JSON widened (7.78 as 7.7799997): two
    // decimals are all the collector computes.
    vs_previous_pct:
      row.vs_previous_pct === null
        ? null
        : Math.round(row.vs_previous_pct * 100) / 100,
    evidence: {
      // a missing artifact is evidenced by where it was expected
      url:
        (row.verdict === "missing"
          ? row.expected_url
          : row.observed_url || row.expected_url) || null,
      http_status: row.http_status,
    },
  };
}

function positionOf(row: ArtifactDbRow): ArtifactCursor["position"]["values"] {
  return [
    Number(row.verdict_rank),
    row.channel,
    row.package_type,
    row.project,
    row.accelerator,
    row.python,
    row.os,
    row.arch,
  ];
}

async function newestRc(version: string): Promise<string | null> {
  const { sql, params } = buildNewestRcQuery(version);
  const rows: { rc: string }[] = await queryClickhouse(
    sql,
    params,
    "api_release_artifact_rc"
  );
  return rows[0]?.rc || null;
}

async function summarize(
  query: ArtifactQuery
): Promise<ArtifactPage["summary"]> {
  const { sql, params } = buildArtifactSummaryQuery(query);
  const rows: { verdict: string; artifacts: number | string }[] =
    await queryClickhouse(sql, params, "api_release_artifact_summary");
  const count = (verdict: string) =>
    Number(rows.find((r) => r.verdict === verdict)?.artifacts ?? 0);
  return {
    expected: rows.reduce((total, r) => total + Number(r.artifacts), 0),
    present: count("present"),
    missing: count("missing"),
    size_anomalous: count("size_anomalous"),
    unexpected: count("unexpected"),
  };
}

export async function listArtifacts({
  query,
  cursor,
}: {
  query: ArtifactQuery;
  cursor: ArtifactCursor | null;
}): Promise<ListPageData<ArtifactPage>> {
  // The cursor binds the request's own query; the release candidate it resolves to is
  // read again on each page, as the board's current_rc is.
  const rc = query.rc ?? (await newestRc(query.version));
  const scoped = rc === null ? query : { ...query, rc };
  const [summary, page] = await Promise.all([
    summarize(scoped),
    queryPage<ArtifactDbRow, ArtifactCursor>({
      build: (boundary, limit) => buildArtifactsQuery(scoped, boundary, limit),
      queryId: "api_release_artifacts_page",
      cursor,
      limit: query.limit,
      createCursor: (row, direction) => ({
        version: 1,
        resource: "release-artifacts",
        direction,
        query: artifactIdentity(query),
        position: { values: positionOf(row) },
      }),
      encodeCursor: encodeArtifactCursor,
    }),
  ]);
  return {
    rc,
    summary,
    rows: page.page.map(toRow),
    next_cursor: page.next_cursor,
    previous_cursor: page.previous_cursor,
  };
}
