import bot from "lib/bot";
import { createNodeMiddleware, createProbot } from "probot";

export default createNodeMiddleware(bot, {
  probot: createProbot(),
  webhooksPath: "/api/github/webhooks",
});
