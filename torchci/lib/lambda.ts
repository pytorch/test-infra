import {
  InvocationType,
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";

export const GHA_LOG_UPLOADER_FUNCTION = "gha-log-uploader";

export class MissingAwsCredentialsError extends Error {
  constructor() {
    // The SDK's own failure here is "Resolved credential object is not valid",
    // which says nothing about which variable to go set.
    super(
      "OUR_AWS_ACCESS_KEY_ID / OUR_AWS_SECRET_ACCESS_KEY are not set, " +
        "cannot reach the log uploader"
    );
    this.name = "MissingAwsCredentialsError";
  }
}

export function getLambdaClient(): LambdaClient {
  const accessKeyId = process.env.OUR_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OUR_AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new MissingAwsCredentialsError();
  }

  return new LambdaClient({
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    // This call sits on the webhook ack path, so it has to fail fast rather than
    // fail well. The SDK defaults to 3 attempts and no socket timeout, which on a
    // black-holed endpoint hangs for the OS default (~75s) per attempt; measured,
    // a connectionTimeout of 1s aborts at ~1.5s instead. Worst case here is
    // roughly 4s, against a 10s GitHub webhook timeout that every other handler
    // also has to fit inside.
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 },
  });
}

export interface LogUploadRequest {
  repo: string;
  job_id: number;
  conclusion?: string | null;
}

/**
 * Ask gha-log-uploader to archive a job's log to S3.
 *
 * Invoked with InvocationType Event, so this returns as soon as Lambda accepts
 * the payload rather than waiting on the GitHub download. That matters because
 * the caller is a Probot webhook handler: Probot only acks GitHub once every
 * handler resolves, and nothing runs after a Vercel function returns, so the
 * handoff has to be both awaited and bounded.
 *
 * Delivery failures are Lambda's problem from here -- it retries twice and then
 * DLQs. Failures to hand off at all reject, and every caller treats that as
 * non-fatal: Dr.CI re-requests a missing log through backfillMissingLog on its
 * next run, so losing a handoff costs a log, never a webhook.
 */
export async function invokeLogUploader(
  request: LogUploadRequest
): Promise<void> {
  await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: GHA_LOG_UPLOADER_FUNCTION,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify(request)),
    })
  );
}
