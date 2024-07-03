// We compute queue times by looking at a snapshot of jobs in CI that are
// currently queued and seeing how long they've existed. This approach doesn't
// give us historical data, so write our snapshot regularly to s3 so we can get
// a view of the queue over time.
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import rockset from "@rockset/client";
import { promises as fs } from "fs";

export function getS3Client() {
  return new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY,
    },
  });
}

const s3client = getS3Client();

async function readJSON(path) {
  const rawData = await fs.readFile(path);
  return JSON.parse(rawData);
}
const prodVersions = await readJSON("./rockset/prodVersions.json");
const client = rockset.default(process.env.ROCKSET_API_KEY);

const response = await client.queryLambdas.executeQueryLambda(
  "metrics",
  "queued_jobs_by_label",
  prodVersions.metrics.queued_jobs_by_label,
  {}
);

s3client.send(
  new PutObjectCommand({
    Bucket: "ossci-raw-job-status",
    Key: `queue_times_historical/${response.results[0]._event_time}`,
    Body: JSON.stringify(response.results),
  })
);
