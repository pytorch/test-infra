import { Artifact } from "./types";
import parseXml from "./parseXml";

export default async function fetchS3Links(
  suiteId: string
): Promise<Artifact[]> {
  let result = (await s3(
    `pytorch/pytorch/${suiteId}/`,
    "gha-artifacts"
  )) as any;
  let prefixes = extractItem(result.ListBucketResult, "CommonPrefixes");
  const artifacts = [];
  // If anything was found, go through the results and add the items to
  // the 'run' object in place
  if (prefixes && prefixes.length > 0) {
    for (const prefixItem of prefixes) {
      let prefix = prefixItem.Prefix["#text"];
      let result = (await s3(prefix, "gha-artifacts")) as any;
      let contents = extractItem(result.ListBucketResult, "Contents");
      for (const content of contents) {
        let prefix = content.Key["#text"];
        let url = `https://gha-artifacts.s3.amazonaws.com/${prefix}`;
        artifacts.push({
          kind: "s3",
          name: prefix.split("/").slice(-1),
          sizeInBytes: parseInt(content.Size["#text"]),
          expired: false,
          url,
        });
      }
    }
  }
  return artifacts;
}

async function s3(prefix: string, bucket: string) {
  // List the gha-artifacts S3 bucket by a specific prefix
  const url =
    `https://${bucket}.s3.amazonaws.com/?` +
    new URLSearchParams({
      "list-type": "2",
      delimiter: "/",
      prefix: prefix,
      "max-keys": "50",
    });
  return await fetch(url)
    .then((a) => a.text())
    .then((a) => {
      return parseXml(a);
    });
}

function extractItem(result: any, key: string): any {
  // Some of the stuff from s3 can come in as a single object or an array,
  // so unpack that here
  if (!result[key]) {
    return null;
  }

  if (Array.isArray(result[key])) {
    return result[key];
  }
  return [result[key]];
}
