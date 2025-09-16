import { createHash } from "crypto";
import { AlertEvent } from "./types";

// Generate stable fingerprint for alert deduplication
export function generateFingerprint(alertEvent: AlertEvent): string {
  if (alertEvent.source === "cloudwatch") {
    return generateCloudWatchFingerprint(alertEvent);
  } else if (alertEvent.source === "grafana") {
    return generateGrafanaFingerprint(alertEvent);
  } else {
    throw new Error(`Unknown alert source: ${alertEvent.source}`);
  }
}

// Generate fingerprint for CloudWatch alerts
function generateCloudWatchFingerprint(alertEvent: AlertEvent): string {
  const fingerprintInputs: Record<string, any> = {
    source: alertEvent.source,
    title: normalizeTitle(alertEvent.title),
  };

  // Add resource identifiers if present
  if (alertEvent.resource.type) {
    fingerprintInputs.resource_type = alertEvent.resource.type;
  }
  if (alertEvent.resource.id) {
    fingerprintInputs.resource_id = alertEvent.resource.id;
  }

  // Add CloudWatch-specific identity fields
  if (alertEvent.identity.aws_account) {
    fingerprintInputs.aws_account = alertEvent.identity.aws_account;
  }
  if (alertEvent.identity.region) {
    fingerprintInputs.region = alertEvent.identity.region;
  }
  if (alertEvent.identity.alarm_arn) {
    fingerprintInputs.alarm_arn = alertEvent.identity.alarm_arn;
  }

  return sortAndHashObject(fingerprintInputs);
}

// Generate fingerprint for Grafana alerts
function generateGrafanaFingerprint(alertEvent: AlertEvent): string {
  const fingerprintInputs: Record<string, any> = {
    source: alertEvent.source,
    title: normalizeTitle(alertEvent.title),
  };

  // Add resource identifiers if present
  if (alertEvent.resource.type) {
    fingerprintInputs.resource_type = alertEvent.resource.type;
  }
  if (alertEvent.resource.id) {
    fingerprintInputs.resource_id = alertEvent.resource.id;
  }

  // Add Grafana-specific identity fields
  if (alertEvent.identity.org_id) {
    fingerprintInputs.org_id = alertEvent.identity.org_id;
  }
  if (alertEvent.identity.rule_id) {
    fingerprintInputs.rule_id = alertEvent.identity.rule_id;
  }

  return sortAndHashObject(fingerprintInputs);
}

// Helper function to create deterministic hash from object
function sortAndHashObject(obj: Record<string, any>): string {
  // Sort keys to ensure deterministic ordering
  const sortedKeys = Object.keys(obj).sort();
  const sortedPairs = sortedKeys.map(key => `${key}=${obj[key]}`);
  const canonicalString = sortedPairs.join("|");

  // Create SHA-256 hash
  return createHash("sha256").update(canonicalString, "utf8").digest("hex");
}

// Normalize title for consistent fingerprinting
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}