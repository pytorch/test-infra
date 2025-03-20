import _ from "lodash";
import { Artifact } from "./types";

const GHA_ARTIFACTS_LAMBDA =
  "https://np6xty2nm6jifkuuyb6wllx6ha0qtthb.lambda-url.us-east-1.on.aws";

export default async function fetchS3Links(
  suiteIds: string
): Promise<Artifact[]> {
  const unflattenedList = await Promise.all(
    _(suiteIds)
      .split(",")
      .uniq()
      .map(async (suiteId) => {
        suiteId = suiteId.trim();
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
        return (
          _.keys(results).map((url: string) => {
            const size = results[url];
            const basename = url.split("/").slice(-1)[0];
            const name =
              basename !== "artifacts.zip"
                ? basename
                : url.split("/").slice(-2).join("/");
            return {
              kind: "s3",
              name: name ?? "",
              sizeInBytes: size ?? 0,
              url: url,
              expired: false,
            };
          }) ?? []
        );
      })
      .value()
  );
  return _.flatten(unflattenedList).sort((a, b) => {
    return a.name.localeCompare(b.name);
  });
}
