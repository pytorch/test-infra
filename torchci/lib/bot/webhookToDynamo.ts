import { v4 as uuidv4 } from "uuid";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import { Context, Probot } from "probot";
import {
  EmitterWebhookEvent as WebhookEvent,
  EmitterWebhookEventName as WebhookEvents,
} from "@octokit/webhooks";

function getDynamoClient(): DynamoDBDocument {
  return DynamoDBDocument.from(
    new DynamoDB({
      credentials: {
        accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY!,
      },
      region: "us-east-1",
    })
  );
}

function narrowType<E extends WebhookEvents>(
  event: E,
  context: WebhookEvent
): context is WebhookEvent<E> {
  return context.name === event;
}

async function handleWorkflowJob(
  event: WebhookEvent<"workflow_run" | "workflow_job">
) {
  // [WebhookEvent typing]: `event` is really a Probot.Context, but if we try to
  // do any strong type checking on `context.payload` TypeScript errors out with
  // "union too complex"-type errors. This is fixed by mostly passing around
  // `event` as a `WebhookEvent` (which it "inherits" from). But sometimes we
  // need the actual context object (for logging and such), so declare it here
  // as well
  const context = event as Context;

  // Thre is the chance that job ids from different repos could collide. To
  // prevent this, prefix the object key with the repo that they come from.
  const key_prefix = event.payload.repository.full_name + "/";

  let key;
  let payload;
  let table;
  if (narrowType("workflow_job", event)) {
    key = `${key_prefix}${event.payload.workflow_job.id}`;
    payload = event.payload.workflow_job;
    table = "torchci-workflow-job";
  } else if (narrowType("workflow_run", event)) {
    key = `${key_prefix}${event.payload.workflow_run.id}`;
    payload = event.payload.workflow_run;
    table = "torchci-workflow-run";
  }

  const client = getDynamoClient();
  await client.put({
    TableName: table,
    Item: {
      dynamoKey: key,
      ...payload,
    },
  });
}

async function handleIssues(event: WebhookEvent<"issues">) {
  const key_prefix = event.payload.repository.full_name + "/";
  const client = getDynamoClient();

  await client.put({
    TableName: "torchci-issues",
    Item: {
      dynamoKey: `${key_prefix}${event.payload.issue.number}`,
      ...event.payload.issue,
    },
  });
}

async function handlePullRequest(event: WebhookEvent<"pull_request">) {
  const key_prefix = event.payload.repository.full_name + "/";
  const client = getDynamoClient();

  await client.put({
    TableName: "torchci-pull-request",
    Item: {
      dynamoKey: `${key_prefix}${event.payload.pull_request.number}`,
      ...event.payload.pull_request,
    },
  });
}

async function handlePush(event: WebhookEvent<"push">) {
  const key_prefix = event.payload.repository.full_name + "/";
  const client = getDynamoClient();

  await client.put({
    TableName: "torchci-push",
    Item: {
      dynamoKey: `${key_prefix}/${uuidv4()}`,
      ...event.payload,
    },
  });
}

export default function webhookToDynamo(app: Probot) {
  app.on(["workflow_job", "workflow_run"], handleWorkflowJob);
  app.on("issues", handleIssues);
  app.on("pull_request", handlePullRequest);
  app.on("push", handlePush);
}
