import { SQSRecord } from "aws-lambda";
import { BaseTransformer } from "./base";
import { GrafanaTransformer } from "./grafana";
import { CloudWatchTransformer } from "./cloudwatch";

// Export all transformer classes
export { BaseTransformer } from "./base";
export { GrafanaTransformer } from "./grafana";
export { CloudWatchTransformer } from "./cloudwatch";

// Factory function to get appropriate transformer based on source
export function getTransformer(source: string): BaseTransformer {
  switch (source.toLowerCase()) {
    case "grafana":
      return new GrafanaTransformer();
    case "cloudwatch":
      return new CloudWatchTransformer();
    default:
      throw new Error(`Unknown alert source: ${source}`);
  }
}

// Detect source type from SQS record
export function detectAlertSource(sqsRecord: SQSRecord): string {
  // First, check SQS message attributes
  const messageAttributes = sqsRecord.messageAttributes;
  if (messageAttributes?.source?.stringValue) {
    return messageAttributes.source.stringValue;
  }

  // Fallback: sniff the payload structure
  try {
    const body = JSON.parse(sqsRecord.body);

    // Check for Grafana-specific fields
    if (body.alerts || body.status || body.orgId || body.receiver) {
      return "grafana";
    }

    // Check for CloudWatch SNS message structure
    if (body.Type === "Notification" && body.Message) {
      try {
        const message = JSON.parse(body.Message);
        if (message.AlarmName && message.NewStateValue) {
          return "cloudwatch";
        }
      } catch {
        // If Message parsing fails, continue with other checks
      }
    }

    // Check for direct CloudWatch alarm structure
    if (body.AlarmName && body.NewStateValue) {
      return "cloudwatch";
    }

    // Default fallback
    console.warn("Could not detect alert source, defaulting to grafana", {
      messageId: sqsRecord.messageId,
      bodyPreview: JSON.stringify(body).substring(0, 200),
    });
    return "grafana";

  } catch (error) {
    console.warn("Failed to parse SQS record body for source detection", {
      messageId: sqsRecord.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "grafana"; // Default fallback
  }
}

// Get transformer for SQS record (convenience function)
export function getTransformerForRecord(sqsRecord: SQSRecord): BaseTransformer {
  const source = detectAlertSource(sqsRecord);
  return getTransformer(source);
}