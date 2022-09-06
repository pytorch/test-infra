import { BigQuery } from "@google-cloud/bigquery";

export function getBigQueryClient(): BigQuery {
  return new BigQuery({
    projectId: "pytorch-ossea13315f",
    credentials: {
      client_email: process.env.GCP_CLIENT_EMAIL as string,
      private_key: (process.env.GCP_PRIVATE_KEY as string).replace(
        /\\n/g,
        "\n"
      ),
    },
  });
}
