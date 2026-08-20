import {
  InvocationType,
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";

export const GHA_LOG_UPLOADER_FUNCTION = "gha-log-uploader";

export function getLambdaClient(): LambdaClient {
  return new LambdaClient({
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY!,
    },
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
 * DLQs. Failures to hand off at all are the caller's, and are non-fatal: Dr.CI
 * re-requests a missing log through backfillMissingLog on its next run.
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
