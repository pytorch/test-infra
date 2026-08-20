import { backfillMissingLog } from "lib/jobUtils";
import * as lambda from "lib/lambda";
import { RecentWorkflowsData } from "lib/types";

const job = { id: 999, conclusion: "failure" } as RecentWorkflowsData;

describe("backfillMissingLog", () => {
  afterEach(() => jest.restoreAllMocks());

  test("queues an upload and reports success", async () => {
    const invoke = jest.spyOn(lambda, "invokeLogUploader").mockResolvedValue();

    await expect(
      backfillMissingLog("pytorch", "executorch", job)
    ).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith({
      repo: "pytorch/executorch",
      job_id: 999,
      conclusion: "failure",
    });
  });

  test.each([
    ["credentials are missing", new lambda.MissingAwsCredentialsError()],
    ["the Lambda API is unreachable", new Error("TimeoutError")],
    ["the role cannot invoke", new Error("AccessDeniedException")],
  ])("returns false rather than throwing when %s", async (_label, error) => {
    // Dr.CI calls this mid-comment-render for every failed job with no log. An
    // exception here would take down the whole Dr.CI run over one missing log.
    jest.spyOn(lambda, "invokeLogUploader").mockRejectedValue(error);
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(backfillMissingLog("pytorch", "pytorch", job)).resolves.toBe(
      false
    );
  });
});
