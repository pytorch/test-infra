import {
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { ARTIFACT_VERDICTS, VersionSchema } from "lib/api/releases/types";
import { pathParameter, queryParameters } from "lib/api/schema";
import { z } from "zod/v4";

export const DEFAULT_ARTIFACT_LIMIT = 50;
export const MAX_ARTIFACT_LIMIT = 500;
const LIMIT_ERROR = `limit must be an integer from 1 to ${MAX_ARTIFACT_LIMIT}`;
const RC_ERROR = "rc must look like rc1";

// The index takes no parameters; the strict empty schema still rejects any query
// parameter as unknown, as every endpoint does.
export const ReleaseIndexParamsSchema = z.strictObject({});

export function parseReleaseIndexParams(rawQuery: RawQuery) {
  return ReleaseIndexParamsSchema.safeParse(rawQuery);
}

export function releaseIndexQueryParameters() {
  return queryParameters(ReleaseIndexParamsSchema);
}

// The board and the config are identified by the version alone.
export const RELEASE_PARAMETER_DEFINITIONS = {
  version: { encoding: "single", schema: VersionSchema },
} as const;

export const ReleaseParamsSchema = parameterSchema(
  RELEASE_PARAMETER_DEFINITIONS
);

export function parseReleaseParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    RELEASE_PARAMETER_DEFINITIONS,
    ReleaseParamsSchema
  );
}

export function releasePathParameters() {
  return [pathParameter("version", ReleaseParamsSchema.shape.version)];
}

export const ARTIFACT_PARAMETER_DEFINITIONS = {
  version: RELEASE_PARAMETER_DEFINITIONS.version,
  channel: {
    encoding: "single",
    schema: z
      .enum(["test", "release"])
      .optional()
      .describe(
        "Only the artifacts of this channel: test for release candidates, release for the final artifacts. Omit for both."
      ),
  },
  rc: {
    encoding: "single",
    schema: z
      .string()
      .regex(/^rc\d+$/, { error: RC_ERROR })
      .optional()
      .describe(
        "The release candidate whose test-channel artifacts to list, for example rc3. Release-channel artifacts are not tied to a release candidate and always match. Omit for the newest release candidate that has observations."
      ),
  },
  package: {
    encoding: "single",
    schema: z
      .enum(["wheel", "libtorch", "docker"])
      .optional()
      .describe("Only this package type. Omit for all."),
  },
  os: {
    encoding: "single",
    schema: z
      .enum(["linux", "windows", "macos"])
      .optional()
      .describe("Only this operating system. Omit for all."),
  },
  verdict: {
    encoding: "single",
    schema: z
      .enum(ARTIFACT_VERDICTS)
      .optional()
      .describe(
        "Only the rows with this verdict. The summary still counts every verdict. Omit for all."
      ),
  },
  limit: {
    encoding: "single",
    schema: z.coerce
      .number({ error: LIMIT_ERROR })
      .int({ error: LIMIT_ERROR })
      .min(1, { error: LIMIT_ERROR })
      .max(MAX_ARTIFACT_LIMIT, { error: LIMIT_ERROR })
      .default(DEFAULT_ARTIFACT_LIMIT)
      .describe("Rows per page."),
  },
  cursor: {
    encoding: "single",
    schema: z
      .string()
      .optional()
      .describe(
        "Opaque pagination.next.cursor or pagination.previous.cursor from a returned page, valid only for the same query except page size."
      ),
  },
} as const;

export const ArtifactParamsSchema = parameterSchema(
  ARTIFACT_PARAMETER_DEFINITIONS
);
export const ArtifactQuerySchema = ArtifactParamsSchema.omit({ cursor: true });
export type ArtifactQuery = z.infer<typeof ArtifactQuerySchema>;

export function parseArtifactParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    ARTIFACT_PARAMETER_DEFINITIONS,
    ArtifactParamsSchema
  );
}

export function artifactParameters() {
  return [
    pathParameter("version", ArtifactParamsSchema.shape.version),
    ...parameterQueryParameters(
      ArtifactParamsSchema.omit({ version: true }),
      ARTIFACT_PARAMETER_DEFINITIONS
    ),
  ];
}
