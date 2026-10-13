import { createHmac, timingSafeEqual } from "crypto";
import { saveSlackUser } from "lib/prNotificationsSlack";
import type { NextApiRequest, NextApiResponse } from "next";

// Slack signs the raw body, so it must not be parsed first
export const config = { api: { bodyParser: false } };

const CHANNEL_ID = "C0C8N0L7U5Q";
const REGISTRATION = /^github:\s*@?([A-Za-z0-9-]{1,39})$/i;
const MAX_REQUEST_AGE_SECONDS = 5 * 60;

async function readBody(req: NextApiRequest): Promise<string> {
  // Decodes characters split across chunks correctly
  req.setEncoding("utf8");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

/** Checks Slack's request signature, see https://api.slack.com/authentication/verifying-requests-from-slack */
function isFromSlack(
  req: NextApiRequest,
  body: string,
  secret: string
): boolean {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (typeof timestamp !== "string" || typeof signature !== "string") {
    return false;
  }
  // Rejects replays of an old request, and a non-numeric timestamp
  if (
    !(
      Math.abs(Date.now() / 1000 - Number(timestamp)) <= MAX_REQUEST_AGE_SECONDS
    )
  ) {
    return false;
  }
  const hmac = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`);
  const expected = new TextEncoder().encode(`v0=${hmac.digest("hex")}`);
  const actual = new TextEncoder().encode(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function react(ts: string) {
  const response = await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PYTORCH_SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: CHANNEL_ID,
      timestamp: ts,
      name: "white_check_mark",
    }),
  });
  const { ok, error } = await response.json();
  // Slack retries an event it thinks failed
  if (!ok && error !== "already_reacted") {
    throw new Error(`reactions.add: ${error}`);
  }
}

/**
 * Slack Events API endpoint of the PyTorch Slack PR review digest app. A member
 * of the opt-in #auto-pr-triage-notifications channel registers by posting
 * `github: <login>` there, which saves their GitHub login and reacts with a
 * checkmark to confirm.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const secret = process.env.PYTORCH_SLACK_SIGNING_SECRET;
  const body = await readBody(req);
  // An unset secret must not turn into an open endpoint.
  if (!secret || !isFromSlack(req, body, secret)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const payload = JSON.parse(body);
  // Sent once when the request URL is set in the Slack app config
  if (payload.type === "url_verification") {
    return res.status(200).json({ challenge: payload.challenge });
  }

  const event = payload.event;
  // A subtype means an edit, join, bot or other non-member message
  const isMemberMessage =
    event?.type === "message" && event.channel === CHANNEL_ID && !event.subtype;
  const match = isMemberMessage && REGISTRATION.exec(event.text?.trim() ?? "");
  if (match) {
    await saveSlackUser(event.user, match[1]);
    await react(event.ts);
  }
  return res.status(200).end();
}
