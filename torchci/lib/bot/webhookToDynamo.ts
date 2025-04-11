import { getDynamoClient } from "lib/dynamo";
import { Context, Probot } from "probot";
import { v4 as uuidv4 } from "uuid";

async function handleWorkflowJob(
  event: Context<"workflow_run" | "workflow_job">
) {
  // Thre is the chance that job ids from different repos could collide. To
  // prevent this, prefix the object key with the repo that they come from.
  const key_prefix = event.payload.repository.full_name + "/";

  let key;
  let table;
  let payload;
  if (event.name === "workflow_job") {
    payload = (event as unknown as Context<"workflow_job">).payload
      .workflow_job;
    key = `${key_prefix}${payload.id}`;
    table = "torchci-workflow-job";
  } else if (event.name === "workflow_run") {
    payload = (event as unknown as Context<"workflow_run">).payload
      .workflow_run;
    key = `${key_prefix}${payload.id}`;
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

async function handleIssues(event: Context<"issues">) {
  const client = getDynamoClient();

  const issue_number = event.payload.issue.number;
  const repo_name = event.payload.repository.full_name;

  await client.put({
    TableName: "torchci-issues",
    Item: {
      dynamoKey: `${repo_name}/${event.payload.issue.number}`,
      ...event.payload.issue,
    },
  });

  if (
    event.payload.action === "labeled" ||
    event.payload.action === "unlabeled"
  ) {
    const datetime = event.payload.issue.updated_at;
    const label_name = event.payload.label?.name;
    await client.put({
      TableName: "torchci-issues-label-event",
      Item: {
        dynamoKey: `${repo_name}/${issue_number}-${label_name}`,
        repo_name: repo_name,
        issue_number: issue_number,
        event_time: datetime,
        label_name: label_name,
        action: event.payload.action,
      },
    });
  }
}

async function handleIssueComment(event: Context<"issue_comment">) {
  const key_prefix = event.payload.repository.full_name;
  const client = getDynamoClient();

  await client.put({
    TableName: "torchci-issue-comment",
    Item: {
      dynamoKey: `${key_prefix}/${event.payload.issue.number}/${event.payload.comment.id}`,
      ...event.payload.comment,
    },
  });
}

async function handlePullRequest(event: Context<"pull_request">) {
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

async function handlePush(event: Context<"push">) {
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

async function handlePullRequestReview(event: Context<"pull_request_review">) {
  const key_prefix = event.payload.repository.full_name;
  const client = getDynamoClient();

  await client.put({
    TableName: "torchci-pull-request-review",
    Item: {
      dynamoKey: `${key_prefix}/${uuidv4()}`,
      ...event.payload,
    },
  });
}

async function handlePullRequestReviewComment(
  event: Context<"pull_request_review_comment">
) {
  const key_prefix = event.payload.repository.full_name;
  const client = getDynamoClient();

  await client.put({
    TableName: "torchci-pull-request-review-comment",
    Item: {
      dynamoKey: `${key_prefix}/${uuidv4()}`,
      ...event.payload,
    },
  });
}

export default function webhookToDynamo(app: Probot) {
  app.on(["workflow_job", "workflow_run"], handleWorkflowJob);
  app.on("issues", handleIssues);
  app.on("issue_comment", handleIssueComment);
  app.on("pull_request", handlePullRequest);
  app.on("pull_request_review", handlePullRequestReview);
  app.on("pull_request_review_comment", handlePullRequestReviewComment);
  app.on("push", handlePush);
}
