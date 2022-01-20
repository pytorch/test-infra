import { createNodeMiddleware, createProbot } from "probot";
import bot from "lib/bot";

export default createNodeMiddleware(bot, {
  probot: createProbot(),
  webhooksPath: "/api/github/webhooks",
});
