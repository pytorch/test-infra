import { getDynamoClient } from "lib/dynamo";

const OOT_TABLE = "torchci-oot-workflow-job";
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB
const DAILY_BUDGET_PER_REPO = 1000;

// ---- Types ----

export interface RelayTrusted {
  verified_repo: string;
  ci_metrics?: {
    queue_time?: number | null;
    execution_time?: number | null;
  };
}

export interface RelayWorkflow {
  status: string;
  conclusion?: string | null;
  name: string;
  url: string;
  test_results?: any;
}

export interface RelayCallbackPayload {
  event_type: string;
  delivery_id: string;
  payload: {
    pull_request?: { number: number; head?: { sha: string } };
    repository?: { full_name: string };
    [key: string]: any;
  };
  workflow: RelayWorkflow;
}

export interface RelayUntrusted {
  callback_payload: RelayCallbackPayload;
}

export interface RelayPayload {
  trusted: RelayTrusted;
  untrusted: RelayUntrusted;
}

export interface OotWorkflowJobRecord {
  dynamoKey: string;
  status: string;
  downstream_repo: string;
  upstream_repo: string;
  pr_number: number;
  pytorch_head_sha: string;
  delivery_id: string;
  workflow_run_url: string;
  workflow_name: string;
  conclusion?: string;
  queue_time?: number | null;
  execution_time?: number | null;
  started_at: string;
  completed_at?: string;
  total_tests?: number;
  passed_tests?: number;
  failed_tests?: number;
  skipped_tests?: number;
  failed_tests_json?: string;
  artifact_url?: string;
  environment?: string;
}

// ---- Validation ----

export function validatePayloadSize(bodyString: string): void {
  if (Buffer.byteLength(bodyString, "utf-8") > MAX_PAYLOAD_BYTES) {
    throw new ApiError(400, "Payload exceeds 2MB limit");
  }
}

export function validateRelayPayload(body: any): RelayPayload {
  if (!body?.trusted?.verified_repo) {
    throw new ApiError(400, "Missing trusted.verified_repo");
  }
  const cb = body?.untrusted?.callback_payload;
  if (!cb) {
    throw new ApiError(400, "Missing untrusted.callback_payload");
  }
  if (!cb.delivery_id) {
    throw new ApiError(400, "Missing delivery_id");
  }
  if (!cb.workflow?.status) {
    throw new ApiError(400, "Missing workflow.status");
  }
  if (!cb.workflow?.name) {
    throw new ApiError(400, "Missing workflow.name");
  }
  if (
    cb.workflow.status !== "in_progress" &&
    cb.workflow.status !== "completed"
  ) {
    throw new ApiError(
      400,
      `Invalid workflow.status: ${cb.workflow.status}. Must be "in_progress" or "completed".`
    );
  }
  if (
    cb.workflow.status === "completed" &&
    !cb.workflow.conclusion
  ) {
    throw new ApiError(
      400,
      "workflow.conclusion is required when status is completed"
    );
  }
  return body as RelayPayload;
}

// ---- Extraction ----

export function extractDynamoRecord(
  payload: RelayPayload
): OotWorkflowJobRecord {
  const { trusted, untrusted } = payload;
  const cb = untrusted.callback_payload;
  const wf = cb.workflow;
  const pr = cb.payload?.pull_request;
  const upstreamRepo =
    cb.payload?.repository?.full_name ?? "pytorch/pytorch";

  const dynamoKey = `${trusted.verified_repo}/${cb.delivery_id}/${wf.name}`;
  const now = new Date().toISOString();

  const record: OotWorkflowJobRecord = {
    dynamoKey,
    status: wf.status,
    downstream_repo: trusted.verified_repo,
    upstream_repo: upstreamRepo,
    pr_number: pr?.number ?? 0,
    pytorch_head_sha: pr?.head?.sha ?? "",
    delivery_id: cb.delivery_id,
    workflow_run_url: wf.url ?? "",
    workflow_name: wf.name,
    queue_time: trusted.ci_metrics?.queue_time,
    execution_time: trusted.ci_metrics?.execution_time,
    started_at: now,
  };

  if (wf.status === "completed") {
    record.conclusion = wf.conclusion ?? undefined;
    record.completed_at = now;

    if (wf.test_results) {
      const tr = wf.test_results;
      if (typeof tr.total === "number") record.total_tests = tr.total;
      if (typeof tr.passed === "number") record.passed_tests = tr.passed;
      if (typeof tr.failed === "number") record.failed_tests = tr.failed;
      if (typeof tr.skipped === "number") record.skipped_tests = tr.skipped;
      if (tr.failures) {
        record.failed_tests_json = JSON.stringify(tr.failures);
      }
    }

    if (typeof cb.workflow.url === "string" && cb.workflow.url) {
      record.artifact_url = cb.workflow.url;
    }
  }

  return record;
}

// ---- Daily Budget ----

export async function checkDailyBudget(repo: string): Promise<void> {
  const client = getDynamoClient();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const keyPrefix = `${repo}/`;

  // Use a scan with a filter to count today's records for this repo.
  // In production, a GSI on (downstream_repo, started_at) would be more efficient.
  const result = await client.query({
    TableName: OOT_TABLE,
    KeyConditionExpression:
      "begins_with(dynamoKey, :prefix)",
    FilterExpression: "begins_with(started_at, :today)",
    ExpressionAttributeValues: {
      ":prefix": keyPrefix,
      ":today": today,
    },
    Select: "COUNT",
  });

  if ((result.Count ?? 0) >= DAILY_BUDGET_PER_REPO) {
    throw new ApiError(
      429,
      `Daily budget exceeded for ${repo} (${DAILY_BUDGET_PER_REPO} callbacks/day)`
    );
  }
}

// ---- DynamoDB Write ----

export async function writeToDynamo(
  record: OotWorkflowJobRecord
): Promise<void> {
  const client = getDynamoClient();
  await client.put({
    TableName: OOT_TABLE,
    Item: record,
  });
}

// ---- Error Helper ----

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
