import type { SQSHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const tableName = process.env.STATUS_TABLE_NAME;
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const parsedBody = JSON.parse(record.body);
      console.log("\n\nMy SQS message body:\n", JSON.stringify(parsedBody, null, 2));
    } catch {
      console.log("\n\nMy SQS message body (not JSON):", record.body);
    }
    if (record.messageAttributes && Object.keys(record.messageAttributes).length > 0) {
      console.log(
        "\n\nMy SQS message attributes:\n",
        JSON.stringify(record.messageAttributes, null, 2)
      );
    }

    // Emit raw message to DynamoDB table if configured
    if (!tableName) {
      console.warn("STATUS_TABLE_NAME not set; skipping DynamoDB write");
      continue;
    }

    try {
      await ddbClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: record.messageId,
            body: record.body,
            attributes: record.messageAttributes && Object.keys(record.messageAttributes).length > 0
              ? record.messageAttributes
              : undefined,
            eventSourceArn: record.eventSourceARN,
            receivedAt: new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      console.error("Failed to write raw message to DynamoDB", {
        error: err instanceof Error ? err.message : String(err),
        table: tableName,
        messageId: record.messageId,
      });
    }
  }
};

export default handler;
