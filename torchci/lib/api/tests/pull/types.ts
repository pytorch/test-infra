import {
  CommitPullRequestSchema,
  CommitRecordSchema,
} from "lib/api/tests/commit/summary/types";
import { TestListPageSchema } from "lib/api/tests/types";
import { z } from "zod/v4";

export const PullRequestHeadSchema = z
  .object({
    number: CommitPullRequestSchema.shape.number.describe(
      "The pull request's number in the repository."
    ),
    title: z
      .string()
      .describe("The pull request's title, from its latest retained record."),
    url: CommitPullRequestSchema.shape.url.describe(
      "The pull request's page on GitHub."
    ),
    head_sha: CommitRecordSchema.shape.sha.describe(
      "Full lowercase SHA of the pull request's newest head commit as HUD knows it: the head its latest record names, unless a later head of the pull request has run pull_request workflows on its branch since the recorded head did, which happens when the record fell behind a push. The commit whose tests the pull request's HUD page opens."
    ),
    hud_url: TestListPageSchema.shape.hud_url
      .unwrap()
      .describe(
        "The HUD page for the pull request, the pullPage operation, with no parameters: it opens the commit page of the pull request's newest head when it is opened, so the link stays current as the pull request moves."
      ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds of the two lookups, the pull request's record and the runs of its heads. They run concurrently, so this sum can exceed wall-clock time. Includes client and network overhead and decoding; excludes SQL construction, mapping and API transport."
    ),
  })
  .describe(
    "A pull request and its newest head commit, the commit whose tests its HUD page opens."
  );
export type PullRequestHead = z.infer<typeof PullRequestHeadSchema>;
