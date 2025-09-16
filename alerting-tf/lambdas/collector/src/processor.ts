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
    // Import AlertStateManager here to avoid circular dependencies
    const { AlertStateManager } = await import("./database");
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");

    const tableName = process.env.STATUS_TABLE_NAME;
    if (!tableName) {
      console.warn("STATUS_TABLE_NAME not set, using simple action determination");
      return alertEvent.state === "FIRING" ? "CREATE" : "SKIP_STALE";
    }

    try {
      const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
      const stateManager = new AlertStateManager(ddbClient, tableName);

      // Check for existing alert state
      const existingState = await stateManager.loadState(fingerprint);

      // If no existing state, handle new alert
      if (!existingState) {
        return alertEvent.state === "FIRING" ? "CREATE" : "SKIP_STALE";
      }

      // Check if manually closed - never auto-act on manually closed alerts
      if (existingState.manually_closed) {
        console.log(`Alert ${fingerprint} was manually closed, skipping auto-action`);
        return "SKIP_MANUAL_CLOSE";
      }

      // Check for out-of-order processing
      const existingTime = new Date(existingState.last_provider_state_at);
      const incomingTime = new Date(alertEvent.occurred_at);

      if (incomingTime < existingTime) {
        console.log(`Out-of-order alert detected for ${fingerprint}, skipping`);
        return "SKIP_STALE";
      }

      // Determine action based on current and desired states
      if (alertEvent.state === "FIRING") {
        if (existingState.status === "CLOSED") {
          // Alert is firing again after being closed - create new issue
          return "CREATE";
        } else if (existingState.status === "OPEN") {
          // Alert is still firing - add comment
          return "COMMENT";
        }
      } else if (alertEvent.state === "RESOLVED") {
        if (existingState.status === "OPEN") {
          // Alert resolved - close the issue
          return "CLOSE";
        } else if (existingState.status === "CLOSED") {
          // Alert already closed - skip
          return "SKIP_STALE";
        }
      }

      // Default fallback
      return "SKIP_STALE";

    } catch (error) {
      console.error("Failed to determine action using DynamoDB state", {
        fingerprint,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to simple logic if DynamoDB fails
      return alertEvent.state === "FIRING" ? "CREATE" : "SKIP_STALE";
    }
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