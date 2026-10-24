import {
  RunListPageSchema,
  RunStatsSchema,
} from "lib/api/tests/test/runs/types";
import { z } from "zod/v4";

export const CommitRunListPageSchema = RunListPageSchema.extend({
  stats: RunStatsSchema.describe(
    "Exact total and per-outcome counts of all retained individual executions for the requested repository and commit SHA, including the initial execution and every attempt after replacement deduplication. Counts executions, not bundles. Search, all run filters including outcome, cursor, limit and sort order do not affect statistics. A filtered or continuation page can be empty while statistics remain positive for the commit. Statistics and the page are separate reads of current data; ingestion, replacements or retention expiry can change counts between requests."
  ),
  query_duration_ms: RunListPageSchema.shape.query_duration_ms.describe(
    "Sum of the individually rounded elapsed milliseconds for the bundle page request, the statistics request, the selected bundles' attempts request, the batched catalog request and the batched workflow metadata request. The page and statistics requests start concurrently; catalog and workflow requests run concurrently during metadata expansion. The attempts, catalog and workflow requests are omitted for an empty page. The statistics request still runs for empty pages. This sum can exceed wall-clock time. Includes client and network overhead and decoding; excludes SQL construction, mapping, cursor encoding and API transport."
  ),
}).describe(
  "A page of retained test run bundles on a commit, with all attempts and exact individual-execution statistics for the entire repository and commit."
);

export type CommitRunListPage = z.infer<typeof CommitRunListPageSchema>;
