import { BaseTransformer } from "./base";
import { AlertEvent, Envelope, AlertResource, AlertIdentity, AlertLinks } from "../types";

export class GrafanaTransformer extends BaseTransformer {
  transform(rawPayload: any, envelope: Envelope): AlertEvent {
    // Validate basic structure
    if (!rawPayload || typeof rawPayload !== "object") {
      throw new Error("Invalid Grafana payload: not an object");
    }

    // Extract first alert from alerts array, or use top-level fields
    const alert = rawPayload.alerts?.[0] || rawPayload;
    const labels = alert.labels || rawPayload.commonLabels || {};
    const annotations = alert.annotations || rawPayload.commonAnnotations || {};

    // Extract core fields
    const title = this.extractTitle(rawPayload, alert, labels);
    const state = this.extractState(rawPayload, alert);
    const priority = this.extractPriority(labels.priority || rawPayload.priority || "");
    const team = this.extractTeam(labels.team || rawPayload.team || "");
    const occurredAt = this.extractOccurredAt(alert, rawPayload);

    // Build resource information
    const resource: AlertResource = {
      type: this.extractResourceType(labels),
      id: labels.resource_id || labels.instance || undefined,
      region: labels.region || undefined,
      extra: this.extractResourceExtra(labels),
    };

    // Build identity information
    const identity: AlertIdentity = {
      org_id: this.safeString(rawPayload.orgId || rawPayload.org_id),
      rule_id: this.safeString(alert.fingerprint || rawPayload.rule_id),
    };

    // Build links
    const links: AlertLinks = {
      runbook_url: annotations.runbook_url || labels.runbook_url || undefined,
      dashboard_url: rawPayload.externalURL || undefined,
      source_url: alert.generatorURL || rawPayload.generatorURL || undefined,
    };

    return {
      schema_version: 1,
      provider_version: "grafana:unknown",
      source: "grafana",
      state,
      title,
      description: annotations.description || annotations.summary || undefined,
      priority,
      occurred_at: occurredAt,
      team,
      resource,
      identity,
      links,
      raw_provider: rawPayload,
    };
  }

  private extractTitle(rawPayload: any, alert: any, labels: any): string {
    const candidates = [
      rawPayload.title,
      labels.alertname,
      alert.labels?.alertname,
      rawPayload.groupLabels?.alertname,
      "Unknown Grafana Alert",
    ];

    for (const candidate of candidates) {
      if (candidate && typeof candidate === "string") {
        return this.normalizeTitle(candidate);
      }
    }

    return "Unknown Grafana Alert";
  }

  private extractState(rawPayload: any, alert: any): "FIRING" | "RESOLVED" {
    const status = alert.status || rawPayload.status || rawPayload.state;

    if (typeof status === "string") {
      const normalized = status.toLowerCase();
      if (normalized === "firing" || normalized === "alerting") return "FIRING";
      if (normalized === "resolved" || normalized === "ok") return "RESOLVED";
    }

    // Default to FIRING if unclear
    return "FIRING";
  }

  private extractOccurredAt(alert: any, rawPayload: any): string {
    const candidates = [
      alert.startsAt,
      alert.endsAt,
      rawPayload.startsAt,
      rawPayload.endsAt,
    ];

    for (const candidate of candidates) {
      if (candidate && candidate !== "0001-01-01T00:00:00Z") {
        return this.parseTimestamp(candidate);
      }
    }

    return new Date().toISOString();
  }

  private extractResourceType(labels: any): AlertResource["type"] {
    const resourceType = labels.resource_type || labels.type;

    if (resourceType) {
      const normalized = resourceType.toLowerCase();
      if (["runner", "instance", "job", "service"].includes(normalized)) {
        return normalized as AlertResource["type"];
      }
    }

    return "generic";
  }

  private extractResourceExtra(labels: any): Record<string, any> | undefined {
    const extra: Record<string, any> = {};

    // Add any additional labels that might be useful
    for (const [key, value] of Object.entries(labels || {})) {
      if (!["alertname", "team", "priority", "resource_type", "resource_id"].includes(key)) {
        extra[key] = value;
      }
    }

    return Object.keys(extra).length > 0 ? extra : undefined;
  }
}