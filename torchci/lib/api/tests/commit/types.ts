import {
  RunListPageSchema,
  RunStatsSchema,
} from "lib/api/tests/test/runs/types";
import { z } from "zod/v4";

export const CommitRunListPageSchema = RunListPageSchema.extend({
  stats: RunStatsSchema.describe(
    "Exact total and per-outcome bundle counts for the requested repository and commit SHA. A bundle is one test, environment, env var set and GitHub job with all of its retained attempts after replacement deduplication; it counts once, under its final outcome, so a test that failed and then passed on retry counts as passed. Search, all run filters including outcome and last_attempt_outcome, cursor, limit and sort order do not affect statistics. A filtered or continuation page can be empty while statistics remain positive for the commit. Statistics and the page are separate reads of current data; ingestion, replacements or retention expiry can change counts between requests."
  ),
  query_duration_ms: RunListPageSchema.shape.query_duration_ms.describe(
    "Sum of the individually rounded elapsed milliseconds for the bundle page request, the boundary probe on nonempty cursor pages, the statistics request, the selected bundles' attempts request, the batched catalog request and the batched workflow metadata request. The page and statistics requests start concurrently; catalog and workflow requests run concurrently during metadata expansion. The attempts, catalog and workflow requests are omitted for an empty page. The statistics request still runs for empty pages. This sum can exceed wall-clock time. Includes client and network overhead and decoding; excludes SQL construction, mapping, cursor encoding and API transport."
  ),
}).describe(
  "A page of retained test run bundles on a commit, with all attempts and exact bundle statistics by final outcome for the entire repository and commit."
);

export type CommitRunListPage = z.infer<typeof CommitRunListPageSchema>;
