import { Artifact } from "./types";

const GHA_ARTIFACTS_LAMBDA =
  "https://np6xty2nm6jifkuuyb6wllx6ha0qtthb.lambda-url.us-east-1.on.aws";

export default async function fetchS3Links(
  suiteId: string
): Promise<Artifact[]> {
  const response = await fetch(GHA_ARTIFACTS_LAMBDA, {
    method: "POST",
    body: JSON.stringify({
      workflow_id: suiteId,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  });

  const results = await response.json();
  const artifacts =
    results.map((artifact: any) => {
      const url = artifact.url;
      const size = artifact.size;

      const basename = artifact.split("/").slice(-1)[0];
      const name =
        basename !== "artifacts.zip"
          ? basename
          : artifact.split("/").slice(-2).join("/");
      return {
        kind: "s3",
        name: name ?? "",
        sizeInBytes: size ?? 0,
        url: url,
        expired: false,
      };
    }) ?? [];
  return artifacts;
}
