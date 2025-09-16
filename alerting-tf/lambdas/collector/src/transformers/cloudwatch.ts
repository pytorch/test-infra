import { BaseTransformer } from "./base";
import { AlertEvent, Envelope, AlertResource, AlertIdentity, AlertLinks } from "../types";

export class CloudWatchTransformer extends BaseTransformer {
  transform(rawPayload: any, envelope: Envelope): AlertEvent {
    // CloudWatch alerts come via SNS, so we need to parse the Message field
    let alarmData: any;

    if (typeof rawPayload === "string") {
      try {
        alarmData = JSON.parse(rawPayload);
      } catch (error) {
        throw new Error(`Invalid CloudWatch payload: failed to parse JSON - ${error}`);
      }
    } else if (rawPayload.Message) {
      // SNS message format
      try {
        alarmData = typeof rawPayload.Message === "string"
          ? JSON.parse(rawPayload.Message)
          : rawPayload.Message;
      } catch (error) {
        throw new Error(`Invalid CloudWatch SNS Message: failed to parse - ${error}`);
      }
    } else {
      // Direct alarm data
      alarmData = rawPayload;
    }

    if (!alarmData || typeof alarmData !== "object") {
      throw new Error("Invalid CloudWatch alarm data: not an object");
    }

    // Extract core fields - fail fast for missing required fields
    if (!alarmData.AlarmName) {
      throw new Error("Missing required AlarmName field");
    }
    const title = this.normalizeTitle(alarmData.AlarmName);
    const state = this.extractState(alarmData);
    const occurredAt = this.parseTimestamp(alarmData.StateChangeTime);

    // Parse AlarmDescription for metadata and description content
    const descriptionParsed = this.parseAlarmDescription(alarmData.AlarmDescription || "");

    if (!descriptionParsed.metadata.PRIORITY) {
      throw new Error("Missing required PRIORITY field in AlarmDescription");
    }
    if (!descriptionParsed.metadata.TEAM) {
      throw new Error("Missing required TEAM field in AlarmDescription");
    }

    const priority = this.extractPriority(descriptionParsed.metadata.PRIORITY);
    const team = this.extractTeam(descriptionParsed.metadata.TEAM);

    // Build resource information
    const resource: AlertResource = {
      type: this.extractResourceType(alarmData),
      id: this.extractResourceId(alarmData),
      region: this.extractRegionFromArn(alarmData.AlarmArn) || this.normalizeRegion(alarmData.Region || ""),
      extra: this.extractResourceExtra(alarmData),
    };

    // Build identity information
    const identity: AlertIdentity = {
      aws_account: this.safeString(alarmData.AWSAccountId),
      region: this.extractRegionFromArn(alarmData.AlarmArn) || this.normalizeRegion(alarmData.Region || ""),
      alarm_arn: this.safeString(alarmData.AlarmArn),
    };

    // Build links with URL validation
    const links: AlertLinks = {
      runbook_url: this.validateUrl(descriptionParsed.metadata.RUNBOOK || ""),
      source_url: this.buildConsoleUrl(alarmData),
    };

    return {
      schema_version: 1,
      provider_version: "cloudwatch:2025-06",
      source: "cloudwatch",
      state,
      title,
      description: descriptionParsed.description || undefined,
      reason: this.sanitizeString(alarmData.NewStateReason || "", 1000),
      priority,
      occurred_at: occurredAt,
      team,
      resource,
      identity,
      links,
      raw_provider: rawPayload,
    };
  }

  private extractState(alarmData: any): "FIRING" | "RESOLVED" {
    const newState = alarmData.NewStateValue;

    if (!newState) {
      throw new Error("Missing required NewStateValue field");
    }

    if (typeof newState === "string") {
      const normalized = newState.toUpperCase();
      if (normalized === "ALARM") return "FIRING";
      if (normalized === "OK") return "RESOLVED";
    }

    throw new Error(`Invalid NewStateValue: '${newState}'. Expected 'ALARM' or 'OK'`);
  }

  private parseAlarmDescription(description: string): { metadata: Record<string, string>; description: string } {
    const metadata: Record<string, string> = {};
    const descriptionLines: string[] = [];

    if (!description || typeof description !== "string") {
      return { metadata, description: "" };
    }

    // Security: Limit description length to prevent DoS attacks
    if (description.length > 4096) {
      throw new Error("AlarmDescription too long (max 4096 characters)");
    }

    // Parse newline-separated format: "Body\nTEAM=team\nPRIORITY=P1\nRUNBOOK=https://..."
    // Also support legacy pipe-separated format for backward compatibility
    const lines = description.includes('\n')
      ? description.split('\n').map(line => line.trim()).slice(0, 20) // Limit number of lines
      : description.split('|').map(pair => pair.trim()).slice(0, 10);

    // Whitelist of allowed keys to prevent injection
    const ALLOWED_KEYS = ['TEAM', 'PRIORITY', 'RUNBOOK', 'SUMMARY'];

    for (const line of lines) {
      // Skip empty lines
      if (!line) {
        continue;
      }

      // Check if this is a metadata line (X=Y format)
      if (line.includes('=')) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          const sanitizedKey = key.trim().toUpperCase();

          // Security: Only allow whitelisted keys
          if (ALLOWED_KEYS.includes(sanitizedKey)) {
            const rawValue = valueParts.join('=').trim();
            // Security: Sanitize and limit value length
            const sanitizedValue = this.sanitizeString(rawValue, 255);
            metadata[sanitizedKey] = sanitizedValue;
          } else {
            // Non-whitelisted X=Y lines are treated as description content
            console.warn(`Non-whitelisted key in AlarmDescription treated as description: ${sanitizedKey}`);
            descriptionLines.push(this.sanitizeString(line, 500));
          }
        }
      } else {
        // Non-X=Y lines are description content
        descriptionLines.push(this.sanitizeString(line, 500));
      }
    }

    return {
      metadata,
      description: descriptionLines.join(' ').trim() || ""
    };
  }

  // Security: Sanitize string input to prevent injection attacks
  private sanitizeString(value: string, maxLength: number = 255): string {
    if (!value || typeof value !== "string") {
      return "";
    }

    // Remove potentially dangerous characters and control characters
    const sanitized = value
      .replace(/[<>\"'&\x00-\x1F\x7F]/g, '') // Remove HTML entities and control chars
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/data:/gi, '') // Remove data: protocol
      .substring(0, maxLength)
      .trim();

    return sanitized;
  }

  private extractResourceType(alarmData: any): AlertResource["type"] {
    const trigger = alarmData.Trigger;
    if (!trigger) return "generic";

    const namespace = trigger.Namespace;
    if (typeof namespace === "string") {
      if (namespace.includes("AutoScaling")) return "instance";
      if (namespace.includes("EC2")) return "instance";
      if (namespace.includes("ECS")) return "service";
      if (namespace.includes("Lambda")) return "service";
    }

    // Check dimensions for hints
    const dimensions = trigger.Dimensions;
    if (Array.isArray(dimensions)) {
      for (const dim of dimensions) {
        if (dim.name === "AutoScalingGroupName") return "instance";
        if (dim.name === "InstanceId") return "instance";
        if (dim.name === "ServiceName") return "service";
      }
    }

    return "generic";
  }

  private extractResourceId(alarmData: any): string | undefined {
    const trigger = alarmData.Trigger;
    if (!trigger?.Dimensions || !Array.isArray(trigger.Dimensions)) {
      return undefined;
    }

    // Look for meaningful resource identifiers
    const dimensionPriority = [
      "AutoScalingGroupName",
      "InstanceId",
      "ServiceName",
      "FunctionName",
      "LoadBalancerName",
    ];

    for (const dimName of dimensionPriority) {
      const dimension = trigger.Dimensions.find((d: any) => d.name === dimName);
      if (dimension?.value) {
        return this.safeString(dimension.value);
      }
    }

    // Fallback to first dimension value
    if (trigger.Dimensions.length > 0 && trigger.Dimensions[0].value) {
      return this.safeString(trigger.Dimensions[0].value);
    }

    return undefined;
  }

  private extractResourceExtra(alarmData: any): Record<string, any> | undefined {
    const extra: Record<string, any> = {};

    // Add trigger information
    const trigger = alarmData.Trigger;
    if (trigger) {
      if (trigger.MetricName) extra.metric_name = trigger.MetricName;
      if (trigger.Namespace) extra.namespace = trigger.Namespace;
      if (trigger.Statistic) extra.statistic = trigger.Statistic;
    }

    // Add threshold information
    if (trigger?.Threshold !== undefined) {
      extra.threshold = trigger.Threshold;
    }
    if (trigger?.ComparisonOperator) {
      extra.comparison_operator = trigger.ComparisonOperator;
    }

    return Object.keys(extra).length > 0 ? extra : undefined;
  }

  private buildConsoleUrl(alarmData: any): string | undefined {
    const alarmName = alarmData.AlarmName;

    if (!alarmName) {
      return undefined;
    }

    // Extract region from ARN first, fallback to display name
    const regionCode = this.extractRegionFromArn(alarmData.AlarmArn) || this.normalizeRegion(alarmData.Region || "");

    if (regionCode) {
      const encodedAlarmName = encodeURIComponent(alarmName);
      return `https://${regionCode}.console.aws.amazon.com/cloudwatch/home?region=${regionCode}#alarmsV2:alarm/${encodedAlarmName}`;
    }

    return undefined;
  }

  private extractRegionFromArn(arn: string | undefined): string | undefined {
    if (!arn || typeof arn !== "string") {
      return undefined;
    }

    // ARN format: arn:aws:cloudwatch:us-east-1:account:alarm/alarm-name
    const arnParts = arn.split(":");
    if (arnParts.length >= 4 && arnParts[3]) {
      return arnParts[3]; // Extract region code directly
    }

    return undefined;
  }

  private normalizeRegion(region: string): string {
    // Map CloudWatch region names to AWS region codes
    const regionMap: Record<string, string> = {
      "US East - N. Virginia": "us-east-1",
      "US East - Ohio": "us-east-2",
      "US West - Oregon": "us-west-2",
      "US West - N. California": "us-west-1",
      "Europe - Ireland": "eu-west-1",
      "Asia Pacific - Tokyo": "ap-northeast-1",
      // Add more mappings as needed
    };

    return regionMap[region] || region.toLowerCase().replace(/\s+/g, "-");
  }
}