// We compute queue times by looking at a snapshot of jobs in CI that are
// currently queued and seeing how long they've existed. This approach doesn't
// give us historical data, so write our snapshot regularly to another Rockset
// collection so we can get a view of the queue over time.
import rockset from "@rockset/client";
import { promises as fs } from "fs";

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

console.log(response);

await client.documents.addDocuments("metrics", "queue_times_historical", {
  data: response.results,
});
