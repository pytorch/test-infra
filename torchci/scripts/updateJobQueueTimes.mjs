// We compute queue times by looking at a snapshot of jobs in CI that are
// currently queued and seeing how long they've existed. This approach doesn't
// give us historical data, so write our snapshot regularly to s3 so we can get
// a view of the queue over time.
// this script is used to update the job queue times in s3 bucket for each job.
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export function getS3Client() {
  return new S3Client({
    region: "us-east-1",
  });
}

const s3client = getS3Client();

// %7B%7D = encoded {}
const response = await fetch(
  "http://localhost:3000/api/clickhouse/queued_jobs?parameters=%7B%7D"
).then((r) => r.json());

const unixTime = Math.floor(Date.now() / 1000);
const json_records = response.map((item) => JSON.stringify(item)).join("\n");

s3client.send(
  new PutObjectCommand({
    Bucket: "ossci-raw-job-status",
    Key: `job_queue_times_historical/${unixTime}.txt`,
    Body: json_records,
  })
);
