import {
  RunListPageSchema,
  RunRecordSchema,
} from "lib/api/tests/test/runs/types";
import { z } from "zod/v4";

export const RunDetailSchema = z
  .object({
    run: RunRecordSchema,
    query_duration_ms: RunListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds for the execution UUID lookup, the bundle attempts lookup, the catalog lookup and the workflow metadata lookup. Catalog and workflow lookups run concurrently, so this sum can exceed wall-clock time. Includes client and network overhead and decoding; excludes SQL construction, mapping and API transport."
    ),
  })
  .describe(
    "The full run bundle containing the requested execution, with the same attempts, catalog details and workflow metadata as the run lists."
  );

export type RunDetail = z.infer<typeof RunDetailSchema>;
