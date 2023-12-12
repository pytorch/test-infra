import { PutObjectCommand } from "@aws-sdk/client-s3";
import s3client from "lib/s3";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const body = JSON.parse(req.body);
  const timestamp = Date.now();

  console.log(body);

  if (req.method == "POST" && body.url.startsWith("https://hud.pytorch.org")) {
    console.log("hello world");
    await s3client.send(
      new PutObjectCommand({
        Bucket: "gha-artifacts",
        Key: `cat_delete_me/${timestamp}.txt`,
        Body: JSON.stringify(body),
      })
    );
  }

  res.status(200).end();
}
