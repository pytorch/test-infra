import { Probot } from "probot";
import { greenlightRepos } from "./greenlightBotConfig";
import { handleGreenlightCommand } from "./greenlightBotHandler";
import { getInputArgs } from "./greenlightCliParser";
import { sourceRepoWriter } from "./greenlightWriter";
import { isRepoEnabled } from "./repoAllowlist";
import { isPyTorchbotSupportedOrg } from "./utils";

function isBotUser(user: { login: string; type: string }): boolean {
  return user.type === "Bot" || user.login.endsWith("[bot]");
}

export default function greenlightBot(app: Probot): void {
  // `created` only: on `edited` any touch of an old comment would re-run the
  // command it contains.
  app.on("issue_comment.created", async (ctx) => {
    if (ctx.payload.issue.pull_request == null) {
      return;
    }
    if (isBotUser(ctx.payload.comment.user)) {
      return;
    }

    // Parsed before the repo gate so an out-of-scope repo can be told its
    // command was ignored without reacting to every comment in that repo.
    const inputArgs = getInputArgs(ctx.payload.comment.body);
    if (inputArgs.length === 0) {
      return;
    }

    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    if (!isPyTorchbotSupportedOrg(owner)) {
      ctx.log(`${__filename} isn't enabled on ${owner}'s repos`);
      return;
    }

    try {
      if (!isRepoEnabled(greenlightRepos(), owner, repo)) {
        ctx.log(`@greenlight is not enabled on ${owner}/${repo}`);
        await sourceRepoWriter(ctx).react("confused");
        return;
      }
      await handleGreenlightCommand(ctx, inputArgs);
    } catch (error) {
      ctx.log.error(
        { err: error },
        `@greenlight command "${inputArgs}" on ${owner}/${repo}#${ctx.payload.issue.number} failed`
      );
    }
  });
}
