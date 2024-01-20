import type { NextApiRequest, NextApiResponse } from "next";
import { getDynamoClient } from "lib/dynamo";
import {
  STSClient,
  AssumeRoleCommand,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{}>
) {
  const region = "us-east-1";
  const client = new STSClient({
    region: region,
  });

  const foobar = await client.send(new GetCallerIdentityCommand({}));
  res.status(200).json(foobar);
}
