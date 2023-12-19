import { S3Client } from "@aws-sdk/client-s3";

export default async function getS3Client(): Promise<S3Client> {
  const s3client = new S3Client({
    region: "us-east-1",
  });
  return s3client;
}
