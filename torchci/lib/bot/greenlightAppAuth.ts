import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";

const PKCS1_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const PKCS1_FOOTER = "-----END RSA PRIVATE KEY-----";

export function greenlightPrivateKey(): string {
  const raw = process.env.GREENLIGHT_APP_PRIVATE_KEY ?? "";
  const key = raw.includes(PKCS1_HEADER)
    ? raw
    : Buffer.from(raw, "base64").toString();

  if (
    !key.includes(PKCS1_HEADER) ||
    !key.includes(PKCS1_FOOTER) ||
    !key.includes("\n")
  ) {
    throw new Error(
      `GREENLIGHT_APP_PRIVATE_KEY must be a PKCS#1 PEM starting with ` +
        `"${PKCS1_HEADER}", or the base64 encoding of one, with real ` +
        `newlines. actions/create-github-app-token also accepts PKCS#8 ` +
        `("-----BEGIN PRIVATE KEY-----"), which probot rejects, so a key ` +
        `copied from the Actions secret may need converting first: ` +
        `openssl rsa -traditional -in key.pem -out key.pkcs1.pem ` +
        `(drop -traditional on LibreSSL, which rejects the flag and already ` +
        `emits PKCS#1; OpenSSL 3.x needs it and silently re-emits PKCS#8 ` +
        `without it)`
    );
  }
  return key;
}

/**
 * Probot answers 202 and abandons the invocation nine seconds into a delivery,
 * without throwing, so anything the handler had left to write is dropped
 * silently. Octokit's throttle plugin spaces mutating requests a second apart
 * and its retry plugin backs off quadratically (1s, 4s, 9s) across three
 * attempts, so a single transient 5xx spends the whole budget on its own.
 * Retrying is wrong here regardless: the workflow dispatch is not idempotent --
 * it can create the run and still answer 5xx -- and a duplicate reviewer run
 * cancels the first one mid-review.
 */
const OCTOKIT_OPTIONS = {
  throttle: { enabled: false },
  retry: { enabled: false },
};

// A minted token's permissions must be a subset of what the App declares, or
// the mint fails with a 422 instead of degrading to a narrower token.
export const SOURCE_REPO_PERMISSIONS = { issues: "write" } as const;
export const DISPATCH_PERMISSIONS = { actions: "write" } as const;

export type ScopedPermissions =
  | typeof SOURCE_REPO_PERMISSIONS
  | typeof DISPATCH_PERMISSIONS;

function appOctokit(): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GREENLIGHT_APP_ID,
      privateKey: greenlightPrivateKey(),
    },
    ...OCTOKIT_OPTIONS,
  });
}

const installationIds = new Map<string, Promise<number>>();

/** Forget a memoized installation id, so the next mint looks it up again. */
export function clearInstallationIdCache(): void {
  installationIds.clear();
}

function installationIdFor(
  app: Octokit,
  owner: string,
  repo: string,
  key: string
): Promise<number> {
  const memoized = installationIds.get(key);
  if (memoized !== undefined) {
    return memoized;
  }

  const pending = app
    .request("GET /repos/{owner}/{repo}/installation", { owner, repo })
    .then((response) => response.data.id)
    .catch((error) => {
      installationIds.delete(key);
      throw new Error(
        `Failed to look up the Green Light App installation on ${owner}/${repo}. ` +
          `Is the App installed there? ${error}`
      );
    });
  installationIds.set(key, pending);
  return pending;
}

/**
 * An installation token handed to a Probot handler carries the App's whole
 * declared permission set on every repo of the installation, which for this App
 * includes dispatching workflows in pytorch/test-infra. Every write the bot
 * makes goes through a token minted here instead, narrowed to one repo and one
 * permission, so a handler bug cannot reach past what that write needs.
 *
 * `knownInstallationId` skips the lookup round trip; webhook deliveries carry
 * the installation the event came from.
 */
export async function mintScopedOctokit(
  owner: string,
  repo: string,
  permissions: ScopedPermissions,
  knownInstallationId?: number
): Promise<Octokit> {
  const app = appOctokit();
  const key = `${owner}/${repo}`.toLowerCase();
  const id =
    knownInstallationId ?? (await installationIdFor(app, owner, repo, key));

  let token;
  try {
    token = await app.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: id, repositories: [repo], permissions }
    );
  } catch (error) {
    // Reinstalling the App gives it a new installation id, which would make
    // every later mint fail against the memoized one until the module recycles.
    installationIds.delete(key);
    throw new Error(
      `Failed to mint a Green Light token for ${owner}/${repo} on installation ` +
        `${id}: ${error}`
    );
  }

  return new Octokit({ auth: token.data.token, ...OCTOKIT_OPTIONS });
}
