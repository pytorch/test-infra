import {
  artifactParameters,
  releaseIndexQueryParameters,
  releasePathParameters,
} from "lib/api/releases/parameters";
import {
  ArtifactPageSchema,
  ArtifactRowSchema,
  ReleaseBoardSchema,
  ReleaseConfigSchema,
  ReleaseIndexSchema,
  ReleaseStepSchema,
} from "lib/api/releases/types";
import type { SchemaRef } from "lib/api/schema";
import { ApiResource, errorResponse, jsonResponse } from "lib/api/schema";

export const RELEASES_TAG = "releases";

// The release endpoints need no token: security is [], overriding the document's
// requirement, and the errors are those a public read has.
function publicErrors(
  ref: SchemaRef,
  invalidRequest: string,
  notFound?: string
) {
  return {
    "400": errorResponse(ref, invalidRequest),
    ...(notFound === undefined ? {} : { "404": errorResponse(ref, notFound) }),
    "500": errorResponse(
      ref,
      "The query or the config failed (internal_error)."
    ),
  };
}

const CACHE_NOTE =
  "Public, no token needed; the answer may be cached for a few minutes. The collector that fills the data runs twice a day.";

export const releasesApiOpenApi: ApiResource = {
  schemas: {
    ReleaseIndex: ReleaseIndexSchema,
    ReleaseBoard: ReleaseBoardSchema,
    ReleaseStep: ReleaseStepSchema,
    ReleaseConfig: ReleaseConfigSchema,
    ReleaseArtifact: ArtifactRowSchema,
    ReleaseArtifactPage: ArtifactPageSchema,
  },
  paths: (ref) => ({
    "/api/releases": {
      get: {
        operationId: "listReleases",
        tags: [RELEASES_TAG],
        security: [],
        summary: "The PyTorch releases the Release Portal tracks",
        description: `Every release the portal has recorded, newest first, with its progress (steps done out of its steps), current phase and status, and \`active\`, the releases that are not out yet, of which there can be more than one, for example a patch release while the next minor release is being prepared. Takes no parameters. ${CACHE_NOTE}`,
        parameters: releaseIndexQueryParameters(),
        responses: {
          "200": jsonResponse("The releases.", ref(ReleaseIndexSchema)),
          ...publicErrors(
            ref,
            "An unsupported parameter (invalid_parameters)."
          ),
        },
      },
    },
    "/api/releases/{version}": {
      get: {
        operationId: "getRelease",
        tags: [RELEASES_TAG],
        security: [],
        summary: "One release's board: its phases, steps and the state of each",
        description: `The release's steps from its config, grouped by phase, each with the state the collector last recorded (done, blocked, in_progress or todo), whether it is blocking, the evidence behind it, when it was checked and, for a step the portal cannot observe, what to check and where. Steps scoped to a release candidate show the state for the newest candidate seen (\`current_rc\`). \`links\` has the release's milestone, tracker issue and validation issue, found on GitHub, and the resources named in the config. The portal is read-only: nothing here records a person's answer. ${CACHE_NOTE}`,
        parameters: releasePathParameters(),
        responses: {
          "200": jsonResponse("The release board.", ref(ReleaseBoardSchema)),
          ...publicErrors(
            ref,
            "A malformed version (invalid_parameters).",
            "No release has this version (not_found)."
          ),
        },
      },
    },
    "/api/releases/{version}/config": {
      get: {
        operationId: "getReleaseConfig",
        tags: [RELEASES_TAG],
        security: [],
        summary: "A release's resolved config",
        description: `The config the portal uses for the release: the shared steps (release/portal/config/steps.yml in pytorch/test-infra) merged with the release's own file, with the steps that do not apply to its type left out. ${CACHE_NOTE}`,
        parameters: releasePathParameters(),
        responses: {
          "200": jsonResponse("The resolved config.", ref(ReleaseConfigSchema)),
          ...publicErrors(
            ref,
            "A malformed version (invalid_parameters).",
            "No release has this version (not_found)."
          ),
        },
      },
    },
    "/api/releases/{version}/artifacts": {
      get: {
        operationId: "listReleaseArtifacts",
        tags: [RELEASES_TAG],
        security: [],
        summary: "A release's expected artifacts and whether each is there",
        description: `One row per expected artifact (accelerator, Python, OS, architecture and package type, per channel), as the collector last saw it on download.pytorch.org, PyPI and Docker Hub: present, missing, size_anomalous or unexpected. Rows come problems first. \`summary\` counts every artifact that matches channel, os and package, so the counts stay put when verdict narrows the rows. Cursor paginated. A release with no recorded artifacts answers zero counts and no rows. ${CACHE_NOTE}`,
        parameters: artifactParameters(),
        responses: {
          "200": jsonResponse(
            "One page of artifacts.",
            ref(ArtifactPageSchema)
          ),
          ...publicErrors(
            ref,
            "A missing, malformed or unsupported parameter (invalid_parameters); a malformed or unsupported cursor (invalid_cursor); or a cursor issued for a different query (cursor_query_mismatch)."
          ),
        },
      },
    },
  }),
};
