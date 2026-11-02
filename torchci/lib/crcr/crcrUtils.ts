import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { getDynamoClient } from "lib/dynamo";

const CRCR_TABLE = "torchci-oot-workflow-job";
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB
// The relay caps the raw verdict at 16 KiB and only shrinks it while
// normalizing, so double that never drops a verdict the relay accepted. Over
// the cap it is dropped.
const MAX_TRIAGE_VERDICT_BYTES = 32 * 1024;

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
  // Required except on nightly/periodic callbacks, which have no check run.
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
  failed_tests_detail?: Array<{
    name: string;
    classname?: string;
    message?: string;
    stacktrace?: string;
    duration?: number;
  }>;
  artifact_url?: string;
  // Advisory triage verdict.
  triage_verdict?: unknown;
}

export interface RelayCallbackPayload {
  event_type: string;
  delivery_id: string;
  payload: {
    pull_request?: { number: number; head?: { sha: string } };
    repository?: { full_name: string };
    ref?: string;
    after?: string;
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
  failed_tests_json?: string;
  environment?: string;
  triage_verdict_json?: string;
}

// ---- Validation ----

export function validatePayloadSize(bodyString: string): void {
  if (Buffer.byteLength(bodyString, "utf-8") > MAX_PAYLOAD_BYTES) {
    throw new ApiError(413, "Payload exceeds 2MB limit");
  }
}

// ---- Extraction ----

// A late report must land on exactly the row the original callback created, so
// both build the key here. Nightly/periodic rows have no check run: checkRunId
// is empty.
export function buildDynamoKey(
  verifiedRepo: string,
  deliveryId: string,
  workflowName: string,
  jobName: string,
  checkRunId: string
): string {
  return `${verifiedRepo}/${deliveryId}/${workflowName}/${jobName}/${checkRunId}`;
}

// The tag `@pytorchbot merge` pushes to trigger trunk validation before
// landing, e.g. refs/tags/ciflow/trunk/12345 -- the PR number is the
// trailing path segment.
const CIFLOW_TRUNK_REF_RE = /\/ciflow\/trunk\/(\d+)$/;

// Event types that self-report a finished run in one callback, with no
// upstream check run behind them (see _handle_nightly_callback in the relay).
const NIGHTLY_EVENT_TYPES = new Set(["nightly", "periodic"]);

// Returns (prNumber, headSha) for a callback's payload. Prefers the
// pull_request shape. Falls back to a push event: PR number is recovered
// only from a ciflow/trunk/<pr> ref, head SHA from payload.after. A push to
// a non-ciflow ref (e.g. a landed merge on main) has no PR to attach to, so
// this returns (0, "") for it -- same as no pull_request at all.
function extractPrContext(payload: RelayCallbackPayload["payload"]): {
  prNumber: number;
  headSha: string;
} {
  const pr = payload?.pull_request;
  if (pr?.number && pr?.head?.sha) {
    return { prNumber: pr.number, headSha: pr.head.sha };
  }
  if (payload?.after) {
    const match = CIFLOW_TRUNK_REF_RE.exec(payload?.ref ?? "");
    return { prNumber: match ? Number(match[1]) : 0, headSha: payload.after };
  }
  return { prNumber: 0, headSha: "" };
}

export function extractDynamoRecord(
  payload: RelayPayload
): CrcrWorkflowJobRecord {
  const { trusted, untrusted } = payload;
  const cb = untrusted.callback_payload;
  const wf = cb.workflow;
  const { prNumber, headSha } = extractPrContext(cb.payload);
  const upstreamRepo = cb.payload?.repository?.full_name ?? "pytorch/pytorch";

  if (!wf.job_name) {
    throw new ApiError(400, "Missing required field: workflow.job_name");
  }
  // check_run_id identifies the upstream check run the relay created to mirror
  // this job. Nightly/periodic callbacks never get one -- they are a single
  // self-report with no check run -- so demanding it rejected every Buildkite
  // nightly job with a 400 that read like a malformed payload. They are still
  // uniquely keyed: a nightly delivery_id is per-job, not per-run.
  const isNightly = NIGHTLY_EVENT_TYPES.has(cb.event_type);
  if (wf.check_run_id == null && !isNightly) {
    throw new ApiError(400, "Missing required field: workflow.check_run_id");
  }
  const jobName = wf.job_name;
  const checkRunId = wf.check_run_id == null ? "" : String(wf.check_run_id);
  const runAttempt = Number(wf.run_attempt ?? 1) || 1;
  const dynamoKey = buildDynamoKey(
    trusted.verified_repo,
    cb.delivery_id,
    wf.name,
    jobName,
    checkRunId
  );

  const record: CrcrWorkflowJobRecord = {
    dynamoKey,
    status: wf.status,
    downstream_repo: trusted.verified_repo,
    upstream_repo: upstreamRepo,
    pr_number: prNumber,
    pytorch_head_sha: headSha || cb.payload?.head_sha || cb.delivery_id || "",
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

    if (wf.failed_tests_detail && Array.isArray(wf.failed_tests_detail)) {
      const MAX_MESSAGE_LEN = 1024;
      const MAX_STACKTRACE_LEN = 4096;
      const MAX_JSON_BYTES = 256 * 1024; // 256 KB budget for failed_tests_json

      const entries: Array<Record<string, unknown>> = [];
      let totalBytes = 2; // account for opening/closing brackets "[]"

      for (const t of wf.failed_tests_detail) {
        if (typeof t !== "object" || t === null) continue;

        const entry: Record<string, unknown> = {
          name: String(t.name ?? ""),
        };
        if (t.classname) entry.classname = String(t.classname);
        if (t.message) {
          entry.message = String(t.message).slice(0, MAX_MESSAGE_LEN);
        }
        if (t.stacktrace) {
          entry.stacktrace = String(t.stacktrace).slice(0, MAX_STACKTRACE_LEN);
        }
        if (t.duration != null) entry.duration = Number(t.duration);

        const entryJson = JSON.stringify(entry);
        const entryBytes = Buffer.byteLength(entryJson, "utf-8");
        const separator = entries.length > 0 ? 1 : 0; // comma between entries
        if (totalBytes + separator + entryBytes > MAX_JSON_BYTES) break;
        totalBytes += separator + entryBytes;
        entries.push(entry);
      }

      if (entries.length > 0) {
        record.failed_tests_json = JSON.stringify(entries);
      }
    }

    const verdict = wf.triage_verdict;
    if (verdict && typeof verdict === "object" && !Array.isArray(verdict)) {
      const verdictJson = JSON.stringify(verdict);
      if (Buffer.byteLength(verdictJson, "utf-8") <= MAX_TRIAGE_VERDICT_BYTES) {
        record.triage_verdict_json = verdictJson;
      }
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

  // Write-once guard: reject writes to already-finalized records.
  // Allows new records (attribute_not_exists) and in_progress → completed
  // transitions, but blocks completed → completed replays.
  expressionNames["#guard_status"] = "status";
  expressionValues[":guard_completed"] = "completed";

  try {
    await client.update({
      TableName: CRCR_TABLE,
      Key: { dynamoKey: record.dynamoKey },
      UpdateExpression: `SET ${expressionParts.join(", ")}`,
      ConditionExpression:
        "attribute_not_exists(#guard_status) OR #guard_status <> :guard_completed",
      ExpressionAttributeValues: expressionValues,
      ExpressionAttributeNames: expressionNames,
    });
  } catch (err: unknown) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new ApiError(
        409,
        `Record already finalized (key=${record.dynamoKey})`
      );
    }
    throw err;
  }
}

// ---- Late report: triage verdicts added after the results were reported ----
//
// A row is write-once (writeToDynamo), but a downstream's triage can finish long
// after it was reported. A late report fills in `triage_verdict_json` on an
// existing, finalized row that has none and changes nothing else. It works for PR
// and nightly/periodic rows; for a PR row the verdict only reaches the HUD (the
// check run and comment are not redone).

export const LATE_REPORT_EVENT_TYPE = "late-report";
// Same cap as the relay, so a request cannot make HUD do unbounded work.
export const MAX_LATE_REPORTS = 100;

export function isLateReport(body: any): boolean {
  return (
    body?.untrusted?.callback_payload?.event_type === LATE_REPORT_EVENT_TYPE
  );
}

export interface LateReport {
  dynamoKey: string;
  triage_verdict_json: string;
  // Identify the report in its result.
  delivery_id: string;
  job_name: string;
  check_run_id?: string;
}

// Only "error" is a failure of ours. The rest describe the row, and sending a
// report again is always safe.
export type LateReportOutcome =
  | "attached"
  | "no_such_row"
  | "not_finalized"
  | "already_has_verdict"
  | "error";

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, `Missing required field: ${field}`);
  }
  return value;
}

function extractOneLateReport(
  verifiedRepo: string,
  entry: any,
  index: number
): LateReport {
  const at = (field: string) => `reports[${index}].${field}`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new ApiError(400, `reports[${index}] must be an object`);
  }
  const deliveryId = requireString(entry.delivery_id, at("delivery_id"));
  const workflowName = requireString(entry.workflow_name, at("workflow_name"));
  const jobName = requireString(entry.job_name, at("job_name"));
  const checkRunId = entry.check_run_id ?? "";
  if (typeof checkRunId !== "string" && typeof checkRunId !== "number") {
    throw new ApiError(
      400,
      `${at("check_run_id")} must be a string or a number`
    );
  }

  const verdict = entry.triage_verdict;
  if (
    typeof verdict !== "object" ||
    verdict === null ||
    Array.isArray(verdict)
  ) {
    throw new ApiError(400, `${at("triage_verdict")} must be an object`);
  }
  const verdictJson = JSON.stringify(verdict);
  if (Buffer.byteLength(verdictJson, "utf-8") > MAX_TRIAGE_VERDICT_BYTES) {
    throw new ApiError(
      400,
      `${at("triage_verdict")} is over the ${MAX_TRIAGE_VERDICT_BYTES} byte cap`
    );
  }

  return {
    dynamoKey: buildDynamoKey(
      verifiedRepo,
      deliveryId,
      workflowName,
      jobName,
      String(checkRunId)
    ),
    triage_verdict_json: verdictJson,
    delivery_id: deliveryId,
    job_name: jobName,
    ...(checkRunId === "" ? {} : { check_run_id: String(checkRunId) }),
  };
}

// `trusted.verified_repo` (the OIDC-verified repo) owns every row, so a repo can
// only reach its own. `untrusted.callback_payload.reports` names each row by the
// values that keyed its original callback (see extractDynamoRecord) and carries
// its verdict, which the relay has validated. One bad entry rejects the whole
// request before anything is written.
export function extractLateReports(body: any): LateReport[] {
  const verifiedRepo = requireString(
    body?.trusted?.verified_repo,
    "trusted.verified_repo"
  );
  const reports = body?.untrusted?.callback_payload?.reports;
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new ApiError(400, "reports must be a non-empty array");
  }
  if (reports.length > MAX_LATE_REPORTS) {
    throw new ApiError(
      400,
      `reports has ${reports.length} entries, over the ${MAX_LATE_REPORTS} cap`
    );
  }
  return reports.map((entry, i) =>
    extractOneLateReport(verifiedRepo, entry, i)
  );
}

export async function writeLateReport(
  report: LateReport
): Promise<LateReportOutcome> {
  const client = getDynamoClient();
  const key = { dynamoKey: report.dynamoKey };
  const names = { "#verdict": "triage_verdict_json", "#status": "status" };

  try {
    await client.update({
      TableName: CRCR_TABLE,
      Key: key,
      UpdateExpression: "SET #verdict = :verdict",
      // attribute_exists keeps UpdateItem from creating a row for a job that was
      // never reported.
      ConditionExpression:
        "attribute_exists(dynamoKey) AND #status = :completed AND " +
        "attribute_not_exists(#verdict)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ":verdict": report.triage_verdict_json,
        ":completed": "completed",
      },
    });
    return "attached";
  } catch (err: unknown) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Tell which condition failed.
    const existing = (
      await client.get({
        TableName: CRCR_TABLE,
        Key: key,
        ProjectionExpression: "#status, #verdict",
        ExpressionAttributeNames: names,
      })
    ).Item;
    if (!existing) return "no_such_row";
    if (existing.status !== "completed") return "not_finalized";
    return "already_has_verdict";
  }
}

// Reports written at once.
const LATE_REPORT_CONCURRENCY = 10;

async function writeLateReportSafely(
  report: LateReport
): Promise<Record<string, string>> {
  let result: LateReportOutcome;
  try {
    result = await writeLateReport(report);
  } catch (err) {
    console.error(`CRCR late report failed (key=${report.dynamoKey}):`, err);
    result = "error";
  }
  return {
    delivery_id: report.delivery_id,
    job_name: report.job_name,
    ...(report.check_run_id ? { check_run_id: report.check_run_id } : {}),
    result,
  };
}

// Results are in request order. One report failing does not stop the rest: it is
// "error", and sending the request again is safe.
export async function writeLateReports(
  reports: LateReport[]
): Promise<Array<Record<string, string>>> {
  const results: Array<Record<string, string>> = [];
  for (let i = 0; i < reports.length; i += LATE_REPORT_CONCURRENCY) {
    const batch = reports.slice(i, i + LATE_REPORT_CONCURRENCY);
    results.push(...(await Promise.all(batch.map(writeLateReportSafely))));
  }
  return results;
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
