import type { SQSHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AlertProcessor } from "./processor";
import { generateFingerprint } from "./fingerprint";
import { AlertStateManager } from "./database";
import { GitHubClient } from "./github/githubClient";

const tableName = process.env.STATUS_TABLE_NAME;
const githubRepo = process.env.GITHUB_REPO || ""; // format: org/repo
const githubAppSecretId = process.env.GITHUB_APP_SECRET_ID || "";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const processor = new AlertProcessor();
const stateManager = tableName ? new AlertStateManager(ddbClient, tableName) : null;
const githubClient = new GitHubClient(githubRepo, githubAppSecretId, 10);


export const handler: SQSHandler = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      // Log incoming record for debugging
      console.log("\n\n");
      console.log("Processing raw record")
      console.log(record);
      console.log("\n\n");
      // continue; // DISABLED: Enable main processing pipeline

      // Process the record through the normalization pipeline
      const result = await processor.processRecord(record);

      if (!result.success) {
        console.error("Alert processing failed", {
          messageId: record.messageId,
          error: result.error,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const { fingerprint, action, metadata } = result;
      if (!fingerprint) {
        console.error("No fingerprint generated", { messageId: record.messageId });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      // Create GitHub issue for all alerts
      let emittedToGithub = false;
      let issueNumber: number | undefined;

      // TEMPORARILY DISABLED: GitHub issue creation
      if (false) {
      try {
        // Build issue title and body from normalized alert
        const alertEvent = result.metadata?.alertEvent;
        if (alertEvent) {
          const issueTitle = `[${alertEvent.priority}] ${alertEvent.title}`;
          const issueBody = [
            `**Alert Details**`,
            `- **Team**: ${alertEvent.team}`,
            `- **Priority**: ${alertEvent.priority}`,
            `- **Source**: ${alertEvent.source}`,
            `- **State**: ${alertEvent.state}`,
            `- **Occurred At**: ${alertEvent.occurred_at}`,
            alertEvent.description ? `- **Description**: ${alertEvent.description}` : "",
            alertEvent.reason ? `- **Reason**: ${alertEvent.reason}` : "",
            alertEvent.links?.runbook_url ? `- **Runbook**: ${alertEvent.links.runbook_url}` : "",
            alertEvent.links?.dashboard_url ? `- **Dashboard**: ${alertEvent.links.dashboard_url}` : "",
            "",
            `**Fingerprint**: \`${fingerprint}\``,
            "",
            "---",
            "```json",
            JSON.stringify(alertEvent.raw_provider, null, 2),
            "```"
          ].filter(Boolean).join("\n");

          // Create labels based on priority, team, source, and default area label
          const labels = [
            "area:alerting", // Default label for all alerts
            `Pri: ${alertEvent.priority}`,
            `Team: ${alertEvent.team}`,
            `Source: ${alertEvent.source}`
          ];

          issueNumber = await githubClient.createGithubIssue(issueTitle, issueBody, labels);
          emittedToGithub = true;
          console.log(`✅ Created GitHub issue #${issueNumber} for fingerprint ${fingerprint}`);
        }
      } catch (err) {
        emittedToGithub = false;
        console.error("Failed to create GitHub issue", {
          fingerprint,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't fail the whole batch for GitHub issues
      }
      } // End TEMPORARILY DISABLED GitHub issue creation

      // Store to DynamoDB using new AlertStateManager
      if (stateManager && result.metadata?.alertEvent) {
        try {
          await stateManager.saveState(
            fingerprint,
            result.metadata.alertEvent,
            action,
            issueNumber
          );
          console.log(`✅ Stored alert state ${fingerprint} to DynamoDB`);
        } catch (err) {
          console.error("Failed to save alert state to DynamoDB", {
            error: err instanceof Error ? err.message : String(err),
            table: tableName,
            messageId: record.messageId,
            fingerprint,
          });
          // DynamoDB failure should fail the record
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      } else {
        console.warn("STATUS_TABLE_NAME not set or no alert event; skipping DynamoDB write");
      }

    } catch (err) {
      console.error(`Failed to process record ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Return batch item failures for SQS partial batch failure handling
  return {
    batchItemFailures
  };
};

export default handler;