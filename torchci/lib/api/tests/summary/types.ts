import { TEST_FIGURE_KINDS } from "lib/api/tests/options/types";
import { WINDOWS } from "lib/api/tests/parameters";
import { TestListPageSchema, TestRecordSchema } from "lib/api/tests/types";
import { z } from "zod/v4";

// One figure per named view of GET /api/tests (options/views.ts): how the
// question each view asks stands, read without listing a page of it. A
// figure is flat: its kind says which of count, duration_milliseconds and
// test carry it, and the others are null. It is of the entries its view
// lists, narrowed by the filters the view's figure.params adds.

export const TestViewFigureSchema = z
  .object({
    id: z
      .string()
      .describe(
        "The view's id, as GET /api/tests/options lists it: flaky_main."
      ),
    kind: z
      .enum(TEST_FIGURE_KINDS)
      .describe(
        "What the figure is, as the view's figure.kind names it: count is in count; slowest in duration_milliseconds and test; total_duration in duration_milliseconds."
      ),
    window: z
      .enum(WINDOWS)
      .describe(
        "The window the figure was read over: the view's own when its params set one, else the request's."
      ),
    count: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "For a count, the entries GET /api/tests lists for the view's params with its figure.params added, over all its pages: one per test, environment and env var set, so a test that fails in three configurations counts three times. For the first view, which lists every entry with the unhealthy ones first, the unhealthy ones, failing or flaky. Null for the other kinds."
      ),
    duration_milliseconds: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "For slowest, the largest health.mean_passed_duration_milliseconds among the figure's entries, which a view sorted by -mean_passed_duration_milliseconds lists first; for total_duration, the machine time the attempts of all the figure's entries took, their health.total_duration_milliseconds summed. Null for a count, and for slowest when no entry has a passed run."
      ),
    test: TestRecordSchema.nullable().describe(
      "For slowest, the test of the entry the duration belongs to; of entries that tie, the one GET /api/tests orders first. Null for the other kinds, and when no entry has a passed run."
    ),
    hud_url: z
      .url()
      .nullable()
      .describe(
        "The HUD tests page (testsPage) showing the view over the figure's window and the request's languages, as GET /api/tests would link it: an absolute URL with the defaults left off. The view's own table, not narrowed by its figure.params. Null when the view uses a parameter the page has no equivalent for."
      ),
  })
  .describe(
    "How one named view of GET /api/tests stands: the view's figure, read over a window and the languages asked for."
  );

export const TestSummarySchema = z
  .object({
    views: z
      .array(TestViewFigureSchema)
      .describe(
        "One figure per view of GET /api/tests/options, in the same order."
      ),
    hud_url: z
      .url()
      .nullable()
      .describe(
        "The HUD tests page (testsPage) of the repository in the request's window and languages, which shows these figures above its table. Absolute."
      ),
    refreshed_at: TestListPageSchema.shape.refreshed_at.describe(
      "The health table's refresh timestamp, read just before the figures; null if the health table is empty at that read. The server keeps the figures for up to a minute and for one refresh, so every figure is of this refresh, or of the next if it landed while the figures were being read. ISO 8601, UTC."
    ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds of the queries made: the refresh timestamp, then the statements that answer the figures, those over the same rows sharing one, and the lookup of the slowest test. The statements run concurrently, so this sum can exceed wall-clock time, and one whose answer the server kept takes a few milliseconds. Includes client and network overhead and decoding; excludes SQL construction, mapping and API transport."
    ),
  })
  .describe(
    "How a repository's tests stand, as one figure per named view of GET /api/tests: how many configurations are failing or flaky, the slowest test, the machine time spent."
  );

export type TestViewFigure = z.infer<typeof TestViewFigureSchema>;
export type TestSummary = z.infer<typeof TestSummarySchema>;
