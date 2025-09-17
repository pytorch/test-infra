import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AlertState, AlertEvent, AlertAction } from "./types";
import { createHash } from "crypto";

export class AlertStateManager {
  constructor(
    private readonly ddbClient: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  // Load existing alert state by fingerprint
  async loadState(fingerprint: string): Promise<AlertState | null> {
    try {
      const result = await this.ddbClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { fingerprint },
        })
      );

      if (!result.Item) {
        return null;
      }

      // Basic validation of required fields
      const item = result.Item;
      if (typeof item.fingerprint !== 'string' ||
          typeof item.status !== 'string' ||
          typeof item.team !== 'string') {
        console.error("Invalid AlertState structure in DynamoDB", {
          fingerprint,
          itemKeys: Object.keys(item),
        });
        throw new Error("Invalid AlertState data structure in database");
      }

      return item as AlertState;
    } catch (error) {
      console.error("Failed to load alert state", {
        fingerprint,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Save new alert state
  async saveState(
    fingerprint: string,
    alertEvent: AlertEvent,
    action: AlertAction,
    issueNumber?: number
  ): Promise<void> {
    const now = new Date().toISOString();
    const ttlExpiresAt = this.calculateTTL();

    const alertState: AlertState = {
      fingerprint,
      status: alertEvent.state === "FIRING" ? "OPEN" : "CLOSED",
      team: alertEvent.team,
      priority: alertEvent.priority,
      title: alertEvent.title,
      issue_repo: process.env.GITHUB_REPO || "unknown/unknown",
      issue_number: issueNumber,
      last_provider_state_at: alertEvent.occurred_at,
      first_seen_at: now,
      last_seen_at: now,
      manually_closed: false,
      schema_version: alertEvent.schema_version,
      provider_version: alertEvent.provider_version,
      identity: alertEvent.identity,
      envelope_digest: this.createEnvelopeDigest(alertEvent),
      ttl_expires_at: ttlExpiresAt,
    };

    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: alertState,
          // Prevent overwriting existing records
          ConditionExpression: "attribute_not_exists(fingerprint)",
        })
      );

      console.log("Alert state saved", {
        fingerprint,
        status: alertState.status,
        team: alertState.team,
        priority: alertState.priority,
      });
    } catch (error) {
      if ((error as any).name === "ConditionalCheckFailedException") {
        // Alert already exists, update it instead
        await this.updateExistingState(fingerprint, alertEvent, action, issueNumber);
      } else {
        console.error("Failed to save alert state", {
          fingerprint,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  // Update existing alert state
  async updateState(
    fingerprint: string,
    updates: Partial<AlertState>
  ): Promise<void> {
    const updateExpression: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    // Build dynamic update expression
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    }

    // Always update last_seen_at
    updateExpression.push("#last_seen_at = :last_seen_at");
    expressionAttributeNames["#last_seen_at"] = "last_seen_at";
    expressionAttributeValues[":last_seen_at"] = new Date().toISOString();

    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { fingerprint },
          UpdateExpression: "SET " + updateExpression.join(", "),
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
        })
      );

      console.log("Alert state updated", { fingerprint, updates });
    } catch (error) {
      console.error("Failed to update alert state", {
        fingerprint,
        updates,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Update existing state when alert already exists with retry logic for race conditions
  private async updateExistingState(
    fingerprint: string,
    alertEvent: AlertEvent,
    action: AlertAction,
    issueNumber?: number
  ): Promise<void> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        // RACE CONDITION FIX: Load current state first for optimistic locking
        const currentState = await this.loadState(fingerprint);
        if (!currentState) {
          // State was deleted between operations - this is rare but possible
          console.warn(`Alert state ${fingerprint} no longer exists during update, skipping`);
          return;
        }

        // Check for out-of-order updates
        const currentTime = new Date(currentState.last_provider_state_at);
        const incomingTime = new Date(alertEvent.occurred_at);

        if (incomingTime < currentTime) {
          console.log(`Out-of-order update detected for ${fingerprint}, skipping`);
          return;
        }

        const updates: Partial<AlertState> = {
          last_provider_state_at: alertEvent.occurred_at,
          provider_version: alertEvent.provider_version,
        };

        // Update status based on alert state
        if (alertEvent.state === "FIRING") {
          updates.status = "OPEN";
        } else if (alertEvent.state === "RESOLVED") {
          updates.status = "CLOSED";
        }

        // Update issue number if provided
        if (issueNumber !== undefined) {
          updates.issue_number = issueNumber;
        }

        // Use conditional update to prevent race conditions
        await this.updateStateConditional(fingerprint, updates, currentState.last_provider_state_at);
        return; // Success, exit retry loop

      } catch (error) {
        retryCount++;

        if ((error as any).name === "ConditionalCheckFailedException") {
          if (retryCount < maxRetries) {
            console.log(`Conditional update failed for ${fingerprint}, retrying (${retryCount}/${maxRetries})`);
            // Exponential backoff: 100ms, 200ms, 400ms
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount - 1)));
            continue;
          } else {
            console.error(`Failed to update ${fingerprint} after ${maxRetries} retries due to concurrent modifications`);
            throw new Error(`Update failed after ${maxRetries} retries - concurrent modification detected`);
          }
        } else {
          // Non-conditional error, don't retry
          throw error;
        }
      }
    }
  }

  // Conditional update with optimistic locking to prevent race conditions
  private async updateStateConditional(
    fingerprint: string,
    updates: Partial<AlertState>,
    expectedLastUpdate: string
  ): Promise<void> {
    const updateExpression: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    // Build dynamic update expression
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    }

    // Always update last_seen_at
    updateExpression.push("#last_seen_at = :last_seen_at");
    expressionAttributeNames["#last_seen_at"] = "last_seen_at";
    expressionAttributeValues[":last_seen_at"] = new Date().toISOString();

    // Add condition for optimistic locking
    expressionAttributeNames["#last_provider_state_at"] = "last_provider_state_at";
    expressionAttributeValues[":expected_last_update"] = expectedLastUpdate;

    await this.ddbClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { fingerprint },
        UpdateExpression: "SET " + updateExpression.join(", "),
        ConditionExpression: "#last_provider_state_at = :expected_last_update",
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    console.log("Alert state updated with optimistic locking", { fingerprint, updates });
  }

  // Calculate TTL (3 years from now in epoch seconds)
  private calculateTTL(): number {
    const threeYearsFromNow = new Date();
    threeYearsFromNow.setFullYear(threeYearsFromNow.getFullYear() + 3);
    return Math.floor(threeYearsFromNow.getTime() / 1000);
  }

  // Create short hash of envelope for audit purposes
  private createEnvelopeDigest(alertEvent: AlertEvent): string {
    const envelopeString = JSON.stringify({
      source: alertEvent.source,
      provider_version: alertEvent.provider_version,
      occurred_at: alertEvent.occurred_at,
    });

    return createHash("sha256")
      .update(envelopeString, "utf8")
      .digest("hex")
      .substring(0, 16); // Keep first 16 characters
  }
}