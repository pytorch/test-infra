import { Client } from "@opensearch-project/opensearch";

export function getOpenSearchClient(): Client {
  // Just remove the https protocol
  const endpoint = process.env.OPENSEARCH_ENDPOINT?.replace(/^https?:\/\//, "");
  const username = encodeURIComponent(process.env.OPENSEARCH_USERNAME ?? "");
  const password = encodeURIComponent(process.env.OPENSEARCH_PASSWORD ?? "");

  // https://opensearch.org/docs/latest/clients/javascript/index. Follow the AWS
  // guide to setup a basic authentcation for a read-only user
  // https://docs.aws.amazon.com/opensearch-service/latest/developerguide/fgac-http-auth.html
  return new Client({
    node: `https://${username}:${password}@${endpoint}`,
  });
}
