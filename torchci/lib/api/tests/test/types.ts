import {
  TestConfigurationHealthSchema,
  TestHealthEntrySchema,
  TestListPageSchema,
  TestRecordSchema,
} from "lib/api/tests/types";
import { z } from "zod/v4";

export const TestDetailSchema = z
  .object({
    test: TestRecordSchema,
    owners: TestHealthEntrySchema.shape.owners,
    health: z
      .array(TestConfigurationHealthSchema)
      .describe(
        "All observed configurations across every stored health window and code source, without pagination. Each item uses the list endpoint's environment, env_vars and health shapes, with a single source in health.ran_on. Windows overlap and must not be summed. Ordered by environment ID, env var set ID, window length, then source. Empty if the test has no health observations."
      ),
    refreshed_at: TestListPageSchema.shape.refreshed_at.describe(
      "Health refresh timestamp read with the health rows. If the test has no health, the current refresh timestamp from a subsequent lookup; null if the health table is empty. That fallback need not reflect the same snapshot. ISO 8601, UTC."
    ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Elapsed milliseconds for the ClickHouse detail request and any empty-health refresh lookup, rounded to the nearest millisecond. Includes client and network overhead and response decoding; excludes SQL construction, response mapping, API routing and transport to the caller."
    ),
  })
  .describe("A test, its owners and all available health information.");

export type TestDetail = z.infer<typeof TestDetailSchema>;
