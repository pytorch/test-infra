import { RunListPageSchema } from "lib/api/tests/test/runs/types";
import { TestListPageSchema } from "lib/api/tests/types";
import { z } from "zod/v4";

export const CommitRunListPageSchema = RunListPageSchema.extend({
  hud_url: TestListPageSchema.shape.hud_url
    .unwrap()
    .describe(
      "The HUD page for the commit's tests, the commitPage operation, with no parameters: the page chooses the outcomes it lists, its filters and its sort itself."
    ),
  query_duration_ms: RunListPageSchema.shape.query_duration_ms.describe(
    "Sum of the individually rounded elapsed milliseconds for the bundle page request, the boundary probe on nonempty cursor pages, the selected bundles' attempts request, the batched catalog request and the batched workflow metadata request. Catalog and workflow requests run concurrently during metadata expansion. The attempts, catalog and workflow requests are omitted for an empty page. This sum can exceed wall-clock time. Includes client and network overhead and decoding; excludes SQL construction, mapping, cursor encoding and API transport."
  ),
}).describe(
  "A page of retained test run bundles on a commit, with all attempts."
);

export type CommitRunListPage = z.infer<typeof CommitRunListPageSchema>;
