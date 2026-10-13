import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "lib/s3";

const BUCKET = "ossci-raw-job-status";
// Read by .github/scripts/pr_notifications_slack.py through the public URL
const SLACK_USERS_KEY = "review-logs/pr-notifications/slack-users.json";
const MAX_SAVE_ATTEMPTS = 3;

type Users = Record<string, string>;

async function readUsers(): Promise<{ users: Users; etag?: string }> {
  try {
    const object = await getS3Client().send(
      new GetObjectCommand({ Bucket: BUCKET, Key: SLACK_USERS_KEY })
    );
    const users = JSON.parse(await object.Body!.transformToString());
    return { users, etag: object.ETag };
  } catch (e: any) {
    // The first registration creates it. Any other read error must fail
    // rather than overwrite the saved mapping with just the new entry.
    if (e?.name === "NoSuchKey") {
      return { users: {} };
    }
    throw e;
  }
}

/**
 * Saves `member` -> `login` to the Slack member ID -> GitHub login mapping of
 * the PyTorch Slack PR review digest.
 */
export async function saveSlackUser(member: string, login: string) {
  for (let attempt = 1; ; attempt++) {
    const { users, etag } = await readUsers();
    try {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: SLACK_USERS_KEY,
          Body: JSON.stringify({ ...users, [member]: login }),
          ContentType: "application/json",
          // Fails if another registration saved in between, which the retry
          // then merges with
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
        })
      );
      return;
    } catch (e: any) {
      const conflict = [409, 412].includes(e?.$metadata?.httpStatusCode);
      if (!conflict || attempt === MAX_SAVE_ATTEMPTS) {
        throw e;
      }
    }
  }
}
