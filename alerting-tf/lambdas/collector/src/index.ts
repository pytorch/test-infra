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
const enableGithubIssues = process.env.ENABLE_GITHUB_ISSUES === "true";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const processor = new AlertProcessor();
const stateManager = tableName ? new AlertStateManager(ddbClient, tableName) : null;
const githubClient = new GitHubClient(githubRepo, githubAppSecretId, 10);

/**
 * Create a GitHub issue for an alert
 */
async function createGitHubIssueForAlert(
  alertEvent: import('./types').AlertEvent,
  fingerprint: string
): Promise<{ success: boolean; issueNumber?: number; error?: string }> {
  try {
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

    const issueNumber = await githubClient.createGithubIssue(issueTitle, issueBody, labels);
    console.log(`✅ Created GitHub issue #${issueNumber} for fingerprint ${fingerprint}`);

    return { success: true, issueNumber };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to create GitHub issue", {
      fingerprint,
      error: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

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

      // Enhanced logging for validation
      console.log("=".repeat(80));
      console.log("🔍 ALERT VALIDATION SUMMARY");
      console.log("=".repeat(80));

      console.log("\n📥 RAW INCOMING PAYLOAD:");
      console.log(JSON.stringify(JSON.parse(record.body), null, 2));

      const alertEvent = result.metadata?.alertEvent;
      if (alertEvent) {
        console.log("\n✨ NORMALIZED ALERT EVENT:");
        console.log(JSON.stringify({
          source: alertEvent.source,
          state: alertEvent.state,
          title: alertEvent.title,
          description: alertEvent.description,
          reason: alertEvent.reason,
          priority: alertEvent.priority,
          team: alertEvent.team,
          occurred_at: alertEvent.occurred_at,
          resource: alertEvent.resource,
          identity: alertEvent.identity,
          links: alertEvent.links,
          schema_version: alertEvent.schema_version,
          provider_version: alertEvent.provider_version
        }, null, 2));
      }

      console.log(`\n🔗 FINGERPRINT: ${fingerprint}`);
      console.log(`⚡ ACTION DETERMINED: ${action}`);
      console.log(`📝 MESSAGE ID: ${record.messageId}`);

      if (alertEvent) {
        const wouldCreateIssue = `[${alertEvent.priority}] ${alertEvent.title}`;
        const wouldCreateLabels = [
          "area:alerting",
          `Pri: ${alertEvent.priority}`,
          `Team: ${alertEvent.team}`,
          `Source: ${alertEvent.source}`
        ];
        console.log(`\n🎫 WOULD CREATE GITHUB ISSUE:`);
        console.log(`   Title: ${wouldCreateIssue}`);
        console.log(`   Labels: ${wouldCreateLabels.join(", ")}`);
        console.log(`   Repo: ${githubRepo}`);
      }

      console.log("=".repeat(80));
      console.log("\n");

      // Initialize GitHub-related variables
      let emittedToGithub = false;
      let issueNumber: number | undefined = undefined;

      // GitHub issue creation (optional - controlled by environment variable)
      if (enableGithubIssues && result.metadata?.alertEvent) {
        try {
          const githubResult = await createGitHubIssueForAlert(result.metadata.alertEvent, fingerprint);
          emittedToGithub = githubResult.success;
          issueNumber = githubResult.issueNumber;
          // Continue processing regardless of GitHub success/failure
        } catch (githubError) {
          console.error("GitHub issue creation failed, continuing with DynamoDB save", {
            fingerprint,
            error: githubError instanceof Error ? githubError.message : String(githubError),
          });
          // Continue processing - GitHub failure should not stop DynamoDB save
        }
      } else if (result.metadata?.alertEvent) {
        console.log(`📝 GitHub issue creation disabled (ENABLE_GITHUB_ISSUES=${enableGithubIssues})`);
      }

      // ALWAYS save to DynamoDB regardless of GitHub status
      if (stateManager && result.metadata?.alertEvent) {
        try {
          await stateManager.saveState(
            fingerprint,
            result.metadata.alertEvent,
            action,
            issueNumber // undefined when GitHub disabled or failed - this is fine
          );
          const githubStatus = emittedToGithub
            ? ` (with GitHub issue #${issueNumber})`
            : enableGithubIssues
              ? ' (GitHub issue creation failed)'
              : ' (GitHub disabled)';
          console.log(`✅ Stored alert state ${fingerprint} to DynamoDB${githubStatus}`);
        } catch (err) {
          console.error("❌ DynamoDB save failed - this will retry the message", {
            error: err instanceof Error ? err.message : String(err),
            table: tableName,
            messageId: record.messageId,
            fingerprint,
            githubEnabled: enableGithubIssues,
            hadIssueNumber: issueNumber !== undefined,
          });
          // DynamoDB failure should fail the record for retry
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      } else {
        console.error("❌ Cannot save to DynamoDB - missing stateManager or alertEvent", {
          hasStateManager: !!stateManager,
          hasAlertEvent: !!result.metadata?.alertEvent,
          tableName,
          messageId: record.messageId,
        });
        // This is a configuration/processing error - fail the record
        batchItemFailures.push({ itemIdentifier: record.messageId });
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