import { S3Client } from "@aws-sdk/client-s3";

const s3client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY!,
  },
});

export default s3client;
