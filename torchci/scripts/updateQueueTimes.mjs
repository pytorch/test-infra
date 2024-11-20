// We compute queue times by looking at a snapshot of jobs in CI that are
// currently queued and seeing how long they've existed. This approach doesn't
// give us historical data, so write our snapshot regularly to s3 so we can get
// a view of the queue over time.
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export function getS3Client() {
  return new S3Client({
    region: "us-east-1",
  });
}

const s3client = getS3Client();

// %7B%7D = encoded {}
const response = await fetch(
  "https://hud.pytorch.org/api/clickhouse/queued_jobs_by_label?parameters=%7B%7D"
).then((r) => r.json());
for (const r of response) {
  const unixTime = parseInt((new Date(r.time).getTime() / 1000).toFixed(0));
  s3client.send(
    new PutObjectCommand({
      Bucket: "ossci-raw-job-status",
      Key: `queue_times_historical/${r.machine_type}/${unixTime}.json`,
      Body: JSON.stringify(r),
    })
  );
}
