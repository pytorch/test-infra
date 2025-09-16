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

    // Priority and team are required and expected in annotations based on reference data
    const priorityValue = annotations.Priority ||
      annotations.priority ||
      labels.priority ||
      rawPayload.priority;

    const teamValue = annotations.Team ||
      annotations.TEAM ||
      annotations.team ||
      labels.team ||
      rawPayload.team;

    if (!priorityValue) {
      throw new Error("Missing required priority field in Grafana alert annotations");
    }
    if (!teamValue) {
      throw new Error("Missing required team field in Grafana alert annotations");
    }

    const priority = this.extractPriority(priorityValue);
    const team = this.extractTeam(teamValue);
    const occurredAt = this.extractOccurredAt(alert, rawPayload);

    // TODO: We should drop this resource type from the design since our alerts will not be sending
    //       resources to us
    // Build resource information
    const resource: AlertResource = {
      type: this.extractResourceType(labels),
      id: labels.resource_id || labels.instance || undefined,
      region: labels.region || undefined,
      extra: this.extractResourceExtra(labels),
    };

    // Build identity information
    const identity: AlertIdentity = {
      org_id: this.safeString(rawPayload.orgId),
      rule_id: this.safeString(alert.fingerprint || rawPayload.rule_id),
    };

    // Build links
    const links: AlertLinks = {
      runbook_url: annotations.runbook_url || labels.runbook_url || undefined,
      dashboard_url: alert.dashboardURL || alert.panelURL || undefined,
      source_url: alert.generatorURL || rawPayload.generatorURL || undefined,
    };

    return {
      schema_version: 1,
      provider_version: "grafana:1.0", // TODO: Add real versioning
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
    // Prioritize raw alertname over formatted titles for consistent fingerprinting
    const candidates = [
      labels.alertname,
      alert.labels?.alertname,
      rawPayload.groupLabels?.alertname,
      rawPayload.title,
    ];

    for (const candidate of candidates) {
      if (candidate && typeof candidate === "string") {
        return this.normalizeTitle(candidate);
      }
    }

    throw new Error("Missing alert title");
  }

  private extractState(rawPayload: any, alert: any): "FIRING" | "RESOLVED" {
    const status = alert.status || rawPayload.status || rawPayload.state;

    if (typeof status === "string") {
      const normalized = status.toLowerCase();
      if (normalized === "firing" || normalized === "alerting") return "FIRING";
      if (normalized === "resolved" || normalized === "ok") return "RESOLVED";
    }

    throw new Error("Unable to determine alert state. Received status: `" + String(status) + "`");
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