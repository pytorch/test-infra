// Core types for alert normalization system

// Envelope: ingest metadata stored with the event for audit and replay triage
export interface Envelope {
  received_at: string; // ISO8601 UTC when Lambda read from SQS
  ingest_topic: string; // SNS topic name
  ingest_region: string; // AWS region of the SNS/SQS path
  delivery_attempt: number; // SQS receive count
  event_id?: string; // deterministic or provider-derived unique id if present
}

// Resource information
export interface AlertResource {
  type: "runner" | "instance" | "job" | "service" | "generic";
  id?: string; // optional string identifier
  region?: string; // optional AWS region
  extra?: Record<string, any>; // small map for context
}

// Identity information for cross-account/region collision prevention
export interface AlertIdentity {
  aws_account?: string; // for CloudWatch (string), optional for Grafana
  region?: string; // for CW/Grafana as relevant
  alarm_arn?: string; // for CW, if available
  org_id?: string; // for Grafana
  rule_id?: string; // for Grafana
}

// Links for navigation and runbooks
export interface AlertLinks {
  runbook_url?: string; // chosen via best-link strategy
  dashboard_url?: string; // if Grafana
  source_url?: string; // console or panel link
}

// Canonical AlertEvent schema (persisted key fields also mirrored in DynamoDB state)
export interface AlertEvent {
  schema_version: number; // integer (start at 1)
  provider_version: string; // free-form string (e.g., grafana:9.5, cloudwatch:2025-06)
  source: "grafana" | "cloudwatch";
  state: "FIRING" | "RESOLVED";
  title: string; // normalized title (rule or alarm name)
  description?: string; // optional summary text
  priority: "P0" | "P1" | "P2" | "P3"; // single canonical concept; no severity field
  occurred_at: string; // provider state change time (ISO8601)
  team: string; // owning team slug (single team in v1)
  resource: AlertResource;
  identity: AlertIdentity;
  links: AlertLinks;
  raw_provider: any; // minimally transformed provider payload for debugging
}

// DynamoDB AlertState record structure
export interface AlertState {
  fingerprint: string; // Primary key
  status: "OPEN" | "CLOSED";
  team: string;
  priority: "P0" | "P1" | "P2" | "P3";
  title: string;
  issue_repo: string; // "pytorch/test-infra"
  issue_number?: number;
  last_provider_state_at: string; // ISO8601
  first_seen_at: string; // ISO8601
  last_seen_at: string; // ISO8601
  manually_closed: boolean;
  manually_closed_at?: string; // ISO8601 (nullable)
  schema_version: number; // mirrors event
  provider_version: string;
  identity: AlertIdentity; // compact map
  envelope_digest: string; // short hash of envelope for audit
  ttl_expires_at: number; // epoch seconds (3-year TTL)
}

// Processing result types
export interface ProcessingResult {
  success: boolean;
  fingerprint?: string;
  action?: AlertAction;
  error?: string;
  metadata?: Record<string, any>;
}

export type AlertAction = "CREATE" | "COMMENT" | "CLOSE" | "SKIP_STALE" | "SKIP_MANUAL_CLOSE";