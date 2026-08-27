import greenlightBot from "lib/bot/greenlightBot";
import { assertGreenlightBotConfig } from "lib/bot/greenlightBotConfig";
import { NextApiRequest, NextApiResponse } from "next";
import { createNodeMiddleware, createProbot } from "probot";

// Next's body parser answers 413 above 1mb, which a delivery for a large pull
// request can exceed, and it would do so before probot ever runs. Signature
// verification is unaffected either way: probot parses the body and re-encodes
// it to check the signature, so it never sees the bytes GitHub sent.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Must match this file's route, or every delivery 404s.
const WEBHOOKS_PATH = "/api/greenlight/webhooks";

let middleware: ReturnType<typeof createNodeMiddleware> | undefined;

// Built on the first delivery rather than at import: a missing secret should
// take down this webhook with an actionable error, not every page of the HUD
// that happens to be built alongside it.
function greenlightMiddleware(): ReturnType<typeof createNodeMiddleware> {
  if (middleware === undefined) {
    assertGreenlightBotConfig();
    middleware = createNodeMiddleware(greenlightBot, {
      probot: createProbot({
        // Through `env`, not `overrides`, so the key goes through
        // @probot/get-private-key and a base64-encoded one is accepted.
        env: {
          ...process.env,
          APP_ID: process.env.GREENLIGHT_APP_ID,
          PRIVATE_KEY: process.env.GREENLIGHT_APP_PRIVATE_KEY,
          WEBHOOK_SECRET: process.env.GREENLIGHT_WEBHOOK_SECRET,
        },
      }),
      webhooksPath: WEBHOOKS_PATH,
    });
  }
  return middleware;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return greenlightMiddleware()(req, res);
}
