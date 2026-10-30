import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  loadPreReviewRechecks,
  savePreReviewRechecks,
} from "lib/preReviewRechecks";
import * as s3 from "lib/s3";

describe("pre-review recheck storage", () => {
  const send = jest.fn();
  beforeEach(() => {
    send.mockReset();
    jest.spyOn(s3, "getS3Client").mockReturnValue({ send } as any);
  });
  afterEach(() => jest.restoreAllMocks());

  test("saves and loads recheck times across invocations", async () => {
    const rechecks = {
      123: { updatedAt: "2026-10-29T12:00:00Z", nextCheckAt: 1793300000000 },
    };
    send.mockResolvedValueOnce({});
    await savePreReviewRechecks(rechecks);
    const put = send.mock.calls[0][0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    send.mockResolvedValueOnce({
      Body: { transformToString: async () => put.input.Body },
    });
    expect(await loadPreReviewRechecks()).toEqual(rechecks);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1][0].input.Key).toBe(put.input.Key);
  });

  test("a missing key starts with an empty cache", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("new cache"), { name: "NoSuchKey" })
    );
    expect(await loadPreReviewRechecks()).toEqual({});
  });

  test("permission and service errors cannot silently disable backoff", async () => {
    send.mockRejectedValue(new Error("AccessDenied"));
    await expect(loadPreReviewRechecks()).rejects.toThrow("AccessDenied");
  });

  test("malformed saved rechecks fail instead of suppressing PR checks indefinitely", async () => {
    send.mockResolvedValue({
      Body: {
        transformToString: async () =>
          '{"123":{"updatedAt":"invalid","nextCheckAt":"never"}}',
      },
    });
    await expect(loadPreReviewRechecks()).rejects.toThrow();
  });
});
