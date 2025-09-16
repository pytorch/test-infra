import { SQSRecord } from "aws-lambda";
import { AlertEvent, Envelope, ProcessingResult, AlertAction } from "./types";
import { getTransformerForRecord, detectAlertSource } from "./transformers";
import { generateFingerprint } from "./fingerprint";

export class AlertProcessor {
  // Process a single SQS record through the normalization pipeline
  async processRecord(sqsRecord: SQSRecord): Promise<ProcessingResult> {
    try {
      // Build envelope from SQS metadata
      const envelope = this.buildEnvelope(sqsRecord);

      // Parse the raw payload
      const rawPayload = this.parseRecordBody(sqsRecord);

      // Normalize the alert
      const alertEvent = await this.normalizeAlert(rawPayload, envelope);

      // Generate fingerprint
      const fingerprint = generateFingerprint(alertEvent);

      // Determine what action to take
      const action = await this.determineAction(alertEvent, fingerprint);

      // Log the normalized alert for debugging
      console.log("NORMALIZED_ALERT", {
        fingerprint,
        alertEvent,
        envelope,
        action,
        messageId: sqsRecord.messageId,
      });

      return {
        success: true,
        fingerprint,
        action,
        metadata: {
          alertEvent,
          source: alertEvent.source,
          team: alertEvent.team,
          priority: alertEvent.priority,
          state: alertEvent.state,
        },
      };

    } catch (error) {
      console.error("Failed to process SQS record", {
        messageId: sqsRecord.messageId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          messageId: sqsRecord.messageId,
        },
      };
    }
  }

  // Build envelope from SQS record metadata
  buildEnvelope(sqsRecord: SQSRecord): Envelope {
    // Extract SNS topic from eventSourceARN if available
    const topicName = this.extractTopicName(sqsRecord.eventSourceARN);

    // Extract region from ARN
    const region = this.extractRegion(sqsRecord.eventSourceARN);

    return {
      received_at: new Date().toISOString(),
      ingest_topic: topicName,
      ingest_region: region,
      delivery_attempt: parseInt(sqsRecord.attributes?.ApproximateReceiveCount || "1", 10),
      event_id: sqsRecord.messageId,
    };
  }

  // Normalize alert using appropriate transformer
  async normalizeAlert(rawPayload: any, envelope: Envelope): Promise<AlertEvent> {
    // Get the appropriate transformer based on payload analysis
    const source = this.detectSourceFromPayload(rawPayload);
    const transformer = getTransformerForRecord({
      body: JSON.stringify(rawPayload),
      messageAttributes: { source: { stringValue: source } },
    } as any);

    return transformer.transform(rawPayload, envelope);
  }

  // Check if alert is out of order (placeholder for future implementation)
  async checkOutOfOrder(alertEvent: AlertEvent, fingerprint: string): Promise<boolean> {
    // TODO: Implement out-of-order detection by checking DynamoDB
    // For now, always return false (not out of order)
    return false;
  }

  // Determine what action to take based on alert state and history
  async determineAction(alertEvent: AlertEvent, fingerprint: string): Promise<AlertAction> {
    // TODO: Implement proper action determination logic
    // For now, simple logic based on state

    if (alertEvent.state === "FIRING") {
      return "CREATE"; // Create new issue or comment on existing
    } else if (alertEvent.state === "RESOLVED") {
      return "CLOSE"; // Close existing issue
    }

    return "CREATE"; // Default fallback
  }

  // Parse SQS record body, handling both string and object formats
  private parseRecordBody(sqsRecord: SQSRecord): any {
    try {
      return JSON.parse(sqsRecord.body);
    } catch (error) {
      // If parsing fails, return the raw body
      // TODO: If SQS record body isn't parsed, then we
      //       can't detect source properly and should just
      //       fail the record instead, let it go to the poison queue.
      console.warn("Failed to parse SQS record body as JSON, using raw string", {
        messageId: sqsRecord.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return sqsRecord.body;
    }
  }

  // Extract SNS topic name from SQS event source ARN
  private extractTopicName(eventSourceARN?: string): string {
    if (!eventSourceARN) return "unknown";

    // SQS ARN format: arn:aws:sqs:region:account:queue-name
    // We want to extract a meaningful name
    const arnParts = eventSourceARN.split(":");
    if (arnParts.length >= 6) {
      return arnParts[5]; // queue name
    }

    return "unknown";
  }

  // Extract AWS region from ARN
  private extractRegion(eventSourceARN?: string): string {
    if (!eventSourceARN) return "unknown";

    const arnParts = eventSourceARN.split(":");
    if (arnParts.length >= 4) {
      return arnParts[3]; // region
    }

    return "unknown";
  }

  // Detect source from raw payload structure - improved detection logic
  private detectSourceFromPayload(rawPayload: any): string {
    if (!rawPayload || typeof rawPayload !== "object") {
      throw new Error("Invalid payload: not an object");
    }

    // Check for Grafana-specific fields
    if (rawPayload.alerts || rawPayload.status || rawPayload.orgId || rawPayload.receiver) {
      return "grafana";
    }

    // Check for CloudWatch SNS message structure
    if (rawPayload.Type === "Notification" && rawPayload.Message) {
      try {
        const message = JSON.parse(rawPayload.Message);
        if (message.AlarmName && message.NewStateValue) {
          return "cloudwatch";
        }
      } catch {
        // If Message parsing fails, continue with other checks
      }
    }

    // Check for direct CloudWatch alarm structure
    if (rawPayload.AlarmName && rawPayload.NewStateValue) {
      return "cloudwatch";
    }

    // If we can't determine the source, fail fast
    throw new Error("Unable to determine alert source from payload structure");
  }
}