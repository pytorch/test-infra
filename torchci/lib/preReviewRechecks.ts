import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PreReviewRechecks } from "lib/bot/preReviewSweep";
import { getS3Client } from "lib/s3";
import { z } from "zod";

const LOCATION = {
  Bucket: "ossci-raw-job-status",
  Key: "pre-review/pytorch-pytorch/rechecks-v1.json",
};

const schema = z.record(
  z.object({
    updatedAt: z.string().datetime(),
    nextCheckAt: z.number().finite(),
  })
);

// S3 persists backoff across serverless invocations. Errors other than a new,
// absent key fail the sweep rather than unexpectedly polling the entire queue.
export async function loadPreReviewRechecks(): Promise<PreReviewRechecks> {
  try {
    const response = await getS3Client().send(new GetObjectCommand(LOCATION));
    const body = await response.Body?.transformToString();
    return schema.parse(JSON.parse(body ?? ""));
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") {
      return {};
    }
    throw error;
  }
}

export async function savePreReviewRechecks(
  rechecks: PreReviewRechecks
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      ...LOCATION,
      Body: JSON.stringify(schema.parse(rechecks)),
      ContentType: "application/json",
    })
  );
}
