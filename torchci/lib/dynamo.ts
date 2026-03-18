import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument, TranslateConfig } from "@aws-sdk/lib-dynamodb";

export function getDynamoClient(
  translateConfig?: TranslateConfig
): DynamoDBDocument {
  return DynamoDBDocument.from(
    new DynamoDB({
      credentials: {
        accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY!,
      },
      region: "us-east-1",
    }),
    translateConfig
  );
}
