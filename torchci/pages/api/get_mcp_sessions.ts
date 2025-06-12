import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "./auth/[...nextauth]";
import { getS3Client } from "../../lib/s3";
import { ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

const s3 = getS3Client();
const BUCKET = process.env.MCP_SESSION_BUCKET_NAME!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const username = session.user.name || session.user.login || session.user.email;
  const key = typeof req.query.key === "string" ? req.query.key : undefined;

  if (req.method === "GET") {
    if (key) {
      try {
        const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const body = await streamToString(data.Body as Readable);
        return res.status(200).json({ session: body });
      } catch (e) {
        return res.status(404).json({ error: "not found" });
      }
    }
    const prefix = `${username}/`;
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    const sessions = (listed.Contents || []).map((o) => ({ key: o.Key, lastModified: o.LastModified }));
    return res.status(200).json({ sessions });
  } else if (req.method === "DELETE") {
    if (!key) return res.status(400).json({ error: "key required" });
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return res.status(200).json({ ok: true });
  }
  res.setHeader("Allow", "GET, DELETE");
  res.status(405).end("Method Not Allowed");
}

async function streamToString(stream: Readable): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}
