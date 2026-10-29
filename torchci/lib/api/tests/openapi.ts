import { listErrorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import { testListQueryParameters } from "lib/api/tests/parameters";
import {
  EnvironmentRecordSchema,
  EnvVarsRecordSchema,
  HealthSummarySchema,
  TestHealthEntrySchema,
  TestListPageSchema,
  TestRecordSchema,
} from "lib/api/tests/types";

// The tests resource's contribution to /api/openapi.json: its schemas and
// its paths, both derived from the zod schemas the handler itself uses.
export const testsApiOpenApi: ApiResource = {
  schemas: {
    TestRecord: TestRecordSchema,
    EnvironmentRecord: EnvironmentRecordSchema,
    EnvVarsRecord: EnvVarsRecordSchema,
    HealthSummary: HealthSummarySchema,
    TestHealthEntry: TestHealthEntrySchema,
    TestListPage: TestListPageSchema,
  },
  paths: (ref) => ({
    "/api/tests": {
      get: {
        operationId: "listTests",
        tags: ["tests"],
        summary: "List a repository's tests with their health",
        description:
          "One entry per test, environment and env var set observed in the requested window and code sources. Each entry includes the test, nullable environment and env var set objects with their IDs, and health combined across the selected code sources. Exact filters combine with AND across fields and OR within a repeated field. All configuration and environment-variable conditions must match the same configuration. Opaque cursors remain usable after health refreshes. Pages read current data and may skip or repeat entries when data or sort values change; they do not enumerate a fixed snapshot.",
        parameters: testListQueryParameters(),
        responses: {
          "200": jsonResponse("A page of entries.", ref(TestListPageSchema)),
          ...listErrorResponses(ref),
        },
      },
    },
  }),
};
