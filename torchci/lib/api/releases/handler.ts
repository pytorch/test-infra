import {
  failQuery,
  handleList,
  jsonError,
  rejectParameters,
  requestQuery,
} from "lib/api/handler";
import { listArtifacts } from "lib/api/releases/artifacts";
import { buildBoard, buildIndex } from "lib/api/releases/board";
import { loadReleaseConfig, loadSharedConfig } from "lib/api/releases/config";
import {
  artifactCursorMatchesQuery,
  decodeArtifactCursor,
} from "lib/api/releases/cursor";
import {
  parseArtifactParams,
  parseReleaseIndexParams,
  parseReleaseParams,
} from "lib/api/releases/parameters";
import { queryStepStates } from "lib/api/releases/state";

// The release endpoints are public (lib/api/public.ts): they carry nothing but the
// state of a release, which the project shows anyone. Each answer may be kept by a
// shared cache for a few minutes; the collector writes twice a day.

const CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

function ok(body: unknown): Response {
  return Response.json(body, { headers: { "Cache-Control": CACHE_CONTROL } });
}

// Every release the collector has written for, with its resolved config. A release
// whose config does not parse is left out, with a warning, rather than failing the
// index for the others.
export async function releaseIndexHandler(request: Request): Promise<Response> {
  const parsed = parseReleaseIndexParams(await requestQuery(request));
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    const [shared, rows] = await Promise.all([
      loadSharedConfig(),
      queryStepStates(null),
    ]);
    const versions = Array.from(new Set(rows.map((row) => row.release)));
    const releases = (
      await Promise.all(
        versions.map(async (version) => {
          try {
            const { config } = await loadReleaseConfig(version, shared);
            return [
              { config, rows: rows.filter((row) => row.release === version) },
            ];
          } catch (error) {
            console.warn(`GET /api/releases: skipping ${version}:`, error);
            return [];
          }
        })
      )
    ).flat();
    return ok(buildIndex(releases, new Date()));
  } catch (error) {
    return failQuery("GET /api/releases", "Failed to list the releases", error);
  }
}

// A release is known when it has a file of its own or the collector has written for
// it; a version with neither is a 404.
async function readRelease(version: string) {
  const [{ config, hasFile }, rows] = await Promise.all([
    loadReleaseConfig(version),
    queryStepStates(version),
  ]);
  return hasFile || rows.length > 0 ? { config, rows } : null;
}

export async function releaseBoardHandler(
  request: Request,
  { params }: { params: Promise<{ version: string }> }
): Promise<Response> {
  const parsed = parseReleaseParams(await requestQuery(request, params));
  if (!parsed.success) return rejectParameters(parsed.error);
  const { version } = parsed.data;
  try {
    const release = await readRelease(version);
    if (release === null) {
      return jsonError(
        404,
        "not_found",
        `The portal has no release ${version}`
      );
    }
    return ok(buildBoard(release.config, release.rows, new Date()));
  } catch (error) {
    return failQuery(
      "GET /api/releases/{version}",
      "Failed to read the release",
      error
    );
  }
}

export async function releaseConfigHandler(
  request: Request,
  { params }: { params: Promise<{ version: string }> }
): Promise<Response> {
  const parsed = parseReleaseParams(await requestQuery(request, params));
  if (!parsed.success) return rejectParameters(parsed.error);
  const { version } = parsed.data;
  try {
    const release = await readRelease(version);
    if (release === null) {
      return jsonError(
        404,
        "not_found",
        `The portal has no release ${version}`
      );
    }
    return ok(release.config);
  } catch (error) {
    return failQuery(
      "GET /api/releases/{version}/config",
      "Failed to read the release's config",
      error
    );
  }
}

export async function releaseArtifactsHandler(
  request: Request,
  { params }: { params: Promise<{ version: string }> }
): Promise<Response> {
  const query = await requestQuery(request, params);
  const response = await handleList(request, query, {
    route: "GET /api/releases/{version}/artifacts",
    failure: "Failed to list the release's artifacts",
    parse: parseArtifactParams,
    decodeCursor: decodeArtifactCursor,
    cursorMatchesQuery: artifactCursorMatchesQuery,
    beforeList: async ({ version }) => {
      if ((await readRelease(version)) === null) {
        return jsonError(
          404,
          "not_found",
          `The portal has no release ${version}`
        );
      }
      return null;
    },
    list: listArtifacts,
  });
  if (response.ok) response.headers.set("Cache-Control", CACHE_CONTROL);
  return response;
}
