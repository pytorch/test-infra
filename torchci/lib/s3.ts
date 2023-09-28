import { PutObjectCommand, S3 } from "@aws-sdk/client-s3";

export async function uploadToS3(bucket: string, key: string, body: string) {
  const client = new S3({
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY!,
    },
  });

  try {
    const data = await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body })
    );
  } catch (error) {
    console.log(error);
  }
}
