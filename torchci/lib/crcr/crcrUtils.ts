import { getDynamoClient } from "lib/dynamo";

const CRCR_TABLE = "torchci-oot-workflow-job";
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB

// ---- Types ----

export interface RelayTrusted {
  verified_repo: string;
  downstream_repo_level?: string; // "L1" | "L2" | "L3" | "L4" — relay-determined from allowlist
  ci_metrics?: {
    queue_time?: number | null;
    execution_time?: number | null;
  };
}

export interface RelayWorkflow {
  schema_version?: string;
  status: string;
  conclusion?: string | null;
  name: string;
  url: string;
  job_name?: string;
  check_run_id?: string;
  run_id?: string;
  run_attempt?: number | string;
  started_at?: string;
  completed_at?: string;
  test_results?: {
    passed?: number;
    failed?: number;
    skipped?: number;
    total?: number;
  };
  artifact_url?: string;
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

export interface CrcrWorkflowJobRecord {
  dynamoKey: string;
  status: string;
  downstream_repo: string;
  upstream_repo: string;
  pr_number: number;
  pytorch_head_sha: string;
  delivery_id: string;
  workflow_run_url: string;
  workflow_name: string;
  job_name: string;
  check_run_id: string;
  run_id: string;
  run_attempt: number;
  conclusion?: string;
  queue_time?: number | null;
  execution_time?: number | null;
  started_at?: string;
  completed_at?: string;
  total_tests?: number;
  passed_tests?: number;
  failed_tests?: number;
  skipped_tests?: number;
  downstream_repo_level?: string;
  event_type?: string;
  artifact_url?: string;
  environment?: string;
}

// ---- Validation ----

export function validatePayloadSize(bodyString: string): void {
  if (Buffer.byteLength(bodyString, "utf-8") > MAX_PAYLOAD_BYTES) {
    throw new ApiError(413, "Payload exceeds 2MB limit");
  }
}

// ---- Extraction ----

export function extractDynamoRecord(
  payload: RelayPayload
): CrcrWorkflowJobRecord {
  const { trusted, untrusted } = payload;
  const cb = untrusted.callback_payload;
  const wf = cb.workflow;
  const pr = cb.payload?.pull_request;
  const upstreamRepo = cb.payload?.repository?.full_name ?? "pytorch/pytorch";

  if (!wf.job_name) {
    throw new ApiError(400, "Missing required field: workflow.job_name");
  }
  if (wf.check_run_id == null) {
    throw new ApiError(400, "Missing required field: workflow.check_run_id");
  }
  const jobName = wf.job_name;
  const checkRunId = String(wf.check_run_id);
  const runAttempt = Number(wf.run_attempt ?? 1) || 1;
  const dynamoKey = `${trusted.verified_repo}/${cb.delivery_id}/${wf.name}/${jobName}/${checkRunId}`;

  const record: CrcrWorkflowJobRecord = {
    dynamoKey,
    status: wf.status,
    downstream_repo: trusted.verified_repo,
    upstream_repo: upstreamRepo,
    pr_number: pr?.number ?? 0,
    pytorch_head_sha: pr?.head?.sha ?? "",
    delivery_id: cb.delivery_id,
    workflow_run_url: wf.url ?? "",
    workflow_name: wf.name,
    job_name: jobName,
    check_run_id: checkRunId,
    run_id: wf.run_id ?? "",
    run_attempt: runAttempt,
  };

  if (trusted.downstream_repo_level) {
    record.downstream_repo_level = trusted.downstream_repo_level;
  }

  if (cb.event_type) {
    record.event_type = cb.event_type;
  }

  // Only set timing metrics when the relay provides a non-null value.
  // in_progress sets queue_time; completed sets execution_time.
  // Using UpdateItem ensures the completed callback doesn't clobber
  // queue_time with null.
  if (trusted.ci_metrics?.queue_time != null) {
    record.queue_time = trusted.ci_metrics.queue_time;
  }
  if (trusted.ci_metrics?.execution_time != null) {
    record.execution_time = trusted.ci_metrics.execution_time;
  }

  // Use downstream-reported timestamps, not HUD wall-clock time
  if (wf.started_at) {
    record.started_at = wf.started_at;
  }

  if (wf.artifact_url) {
    record.artifact_url = wf.artifact_url;
  }

  if (wf.status === "completed") {
    record.conclusion = wf.conclusion ?? undefined;
    if (wf.completed_at) {
      record.completed_at = wf.completed_at;
    }

    if (wf.test_results) {
      const tr = wf.test_results;
      if (typeof tr.passed === "number") record.passed_tests = tr.passed;
      if (typeof tr.failed === "number") record.failed_tests = tr.failed;
      if (typeof tr.skipped === "number") record.skipped_tests = tr.skipped;
      record.total_tests =
        typeof tr.total === "number"
          ? tr.total
          : (tr.passed ?? 0) + (tr.failed ?? 0) + (tr.skipped ?? 0);
    }
  }

  return record;
}

// ---- DynamoDB Write (UpdateItem) ----

export async function writeToDynamo(
  record: CrcrWorkflowJobRecord
): Promise<void> {
  const client = getDynamoClient();

  // Build SET expression dynamically — only set non-undefined fields.
  // This prevents completed callbacks from clobbering in_progress-only
  // fields (queue_time, started_at) with null.
  const expressionParts: string[] = [];
  const expressionValues: Record<string, any> = {};
  const expressionNames: Record<string, string> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === "dynamoKey" || value === undefined) continue;
    const placeholder = `:v_${key}`;
    const nameAlias = `#n_${key}`;
    expressionParts.push(`${nameAlias} = ${placeholder}`);
    expressionValues[placeholder] = value;
    expressionNames[nameAlias] = key;
  }

  await client.update({
    TableName: CRCR_TABLE,
    Key: { dynamoKey: record.dynamoKey },
    UpdateExpression: `SET ${expressionParts.join(", ")}`,
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: expressionNames,
  });
}

// ---- UI Helpers ----

export type ChipColor = "success" | "error" | "warning" | "info" | "default";

export function conclusionColor(status: string, conclusion: string): ChipColor {
  if (status === "in_progress") return "info";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
      return "error";
    case "cancelled":
    case "timed_out":
      return "warning";
    default:
      return "default";
  }
}

export function conclusionLabel(status: string, conclusion: string): string {
  if (status === "in_progress") return "running";
  return conclusion || status;
}

// ---- Error Helper ----

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
