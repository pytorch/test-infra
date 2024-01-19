import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { DynamoDBDocument, TranslateConfig } from "@aws-sdk/lib-dynamodb";
import { v4 } from "uuid";

const REGION = "us-east-1";
const CLIENT = new STSClient({
  region: REGION,
});

export async function getDynamoClient(
  translateConfig?: TranslateConfig
): Promise<DynamoDBDocument> {
  const cmd = new AssumeRoleCommand({
    RoleArn: "arn:aws:iam::308535385114:role/DEBUG-TO-BE-DELETED",
    RoleSessionName: v4(),
    DurationSeconds: 900,
  });
  const response = await CLIENT.send(cmd);

  return DynamoDBDocument.from(
    new DynamoDB({
      credentials: {
        accessKeyId: response.Credentials!.AccessKeyId!,
        secretAccessKey: response.Credentials!.SecretAccessKey!,
        sessionToken: response.Credentials!.SessionToken,
      },
      region: REGION,
    }),
    translateConfig
  );
}
