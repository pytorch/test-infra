import { greenlightPrivateKey } from "./greenlightAppAuth";
import { parseRepoAllowlist } from "./repoAllowlist";

const REPOS_ENV_VAR = "GREENLIGHT_BOT_REPOS";

const REQUIRED_ENV_VARS = [
  "GREENLIGHT_APP_ID",
  "GREENLIGHT_APP_PRIVATE_KEY",
  "GREENLIGHT_WEBHOOK_SECRET",
  REPOS_ENV_VAR,
];

/** The repos `@greenlight` answers on, as an `owner/repo` or `owner/*` list. */
export function greenlightRepos(): Set<string> {
  return parseRepoAllowlist(process.env[REPOS_ENV_VAR]);
}

export function assertGreenlightBotConfig(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `The greenlight bot cannot start without ${missing.join(", ")}. Probot ` +
        `falls back to an appId of NaN and to the literal webhook secret ` +
        `"development" when the App variables are unset, which rejects every ` +
        `delivery without reporting anything at startup, and an unset ` +
        `${REPOS_ENV_VAR} enables the bot on nothing at all. Set them on the ` +
        `Vercel project; the values are in Keeper.`
    );
  }
  greenlightPrivateKey();
}
