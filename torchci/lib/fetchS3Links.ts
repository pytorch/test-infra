import { Artifact } from "./types";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import s3client from "./s3";
export default async function fetchS3Links(
  suiteId: string
): Promise<Artifact[]> {
  const command = new ListObjectsV2Command({
    Bucket: "gha-artifacts",
    Prefix: `pytorch/pytorch/${suiteId}`,
  });
  const response = await s3client.send(command);

  const artifacts =
    response.Contents?.map((jobs) => {
      const name = jobs.Key?.split("/").slice(-1)[0];
      return {
        kind: "s3",
        name: name ?? "",
        sizeInBytes: jobs.Size ?? 0,
        url: `https://gha-artifacts.s3.amazonaws.com/${jobs.Key}`,
        expired: false,
      };
    }) ?? [];
  return artifacts;
}
