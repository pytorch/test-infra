/**
 * Helpers for minting per-user, read-only (Viewer) Grafana service-account
 * tokens against pytorchci.grafana.net.
 *
 * Used by the `/api/gcx-token` route so contributors can self-serve a
 * `GRAFANA_TOKEN` for the `gcx` CLI without manually creating one in the
 * Grafana UI. Each GitHub user gets a dedicated service account named
 * `gcx-<github-login>` with the Viewer role.
 *
 * Requires the server-side env var `GRAFANA_ADMIN_TOKEN`: a Grafana
 * service-account token with `serviceaccounts:write` /
 * `serviceaccounts.tokens:write` (Admin role). It is NEVER returned to callers.
 */

const DEFAULT_GRAFANA_SERVER = "https://pytorchci.grafana.net";

export function grafanaServer(): string {
  return process.env.GRAFANA_SERVER || DEFAULT_GRAFANA_SERVER;
}

async function grafanaFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const adminToken = process.env.GRAFANA_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error("GRAFANA_ADMIN_TOKEN is not configured");
  }
  return fetch(`${grafanaServer()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

// GitHub logins are [A-Za-z0-9-]; strip anything else defensively so the
// service-account name can never be used to smuggle unexpected characters.
function serviceAccountName(login: string): string {
  const safe = login.replace(/[^A-Za-z0-9-]/g, "");
  if (!safe) {
    throw new Error("Invalid GitHub login");
  }
  return `gcx-${safe}`;
}

async function findServiceAccountIdByName(
  name: string
): Promise<number | null> {
  const res = await grafanaFetch(
    `/api/serviceaccounts/search?perpage=100&page=1&query=${encodeURIComponent(
      name
    )}`
  );
  if (!res.ok) {
    throw new Error(
      `Grafana service-account search failed: ${res.status} ${await res.text()}`
    );
  }
  const data = await res.json();
  const match = (data?.serviceAccounts || []).find(
    (sa: { id: number; name: string }) => sa.name === name
  );
  return match ? match.id : null;
}

async function createViewerServiceAccount(name: string): Promise<number> {
  const res = await grafanaFetch("/api/serviceaccounts", {
    method: "POST",
    body: JSON.stringify({ name, role: "Viewer", isDisabled: false }),
  });
  if (!res.ok) {
    throw new Error(
      `Grafana service-account create failed: ${res.status} ${await res.text()}`
    );
  }
  const data = await res.json();
  return data.id;
}

// Delete tokens on the service account whose name starts with `prefix`, so a
// new mint supersedes only the previous token with the same label, leaving
// other labels' tokens intact.
async function revokeTokensWithPrefix(
  saId: number,
  prefix: string
): Promise<void> {
  const res = await grafanaFetch(`/api/serviceaccounts/${saId}/tokens`);
  if (!res.ok) {
    throw new Error(
      `Grafana token list failed: ${res.status} ${await res.text()}`
    );
  }
  const tokens: Array<{ id: number; name: string }> = (await res.json()) || [];
  for (const token of tokens) {
    if (token.name.startsWith(prefix)) {
      await grafanaFetch(`/api/serviceaccounts/${saId}/tokens/${token.id}`, {
        method: "DELETE",
      });
    }
  }
}

// Slug for the caller-supplied token label (no dashes, so it can't collide with
// the dash separators in the token name). Defaults to "default".
function labelSlug(label: string): string {
  return (label || "").replace(/[^A-Za-z0-9.]/g, "").slice(0, 40) || "default";
}

/**
 * Find-or-create the Viewer service account for `login`, revoke any previous
 * token with the same `label`, and mint a fresh one. Returns the raw token key
 * (the only time Grafana exposes it). Tokens are named per label so a user can
 * hold one per machine; re-minting with the same label replaces that token.
 */
export async function mintGcxViewerToken(
  login: string,
  label: string
): Promise<string> {
  const name = serviceAccountName(login);
  const prefix = `${name}-${labelSlug(label)}-`;

  let saId = await findServiceAccountIdByName(name);
  if (saId == null) {
    saId = await createViewerServiceAccount(name);
  } else {
    await revokeTokensWithPrefix(saId, prefix);
  }

  // Timestamp keeps the token name unique per (service account, label).
  const tokenName = `${prefix}${Date.now()}`;
  const res = await grafanaFetch(`/api/serviceaccounts/${saId}/tokens`, {
    method: "POST",
    body: JSON.stringify({ name: tokenName }),
  });
  if (!res.ok) {
    throw new Error(
      `Grafana token create failed: ${res.status} ${await res.text()}`
    );
  }
  const data = await res.json();
  if (!data?.key) {
    throw new Error("Grafana token create returned no key");
  }
  return data.key;
}
