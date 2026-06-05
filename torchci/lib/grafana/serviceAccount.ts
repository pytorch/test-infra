/**
 * Helpers for minting per-user, read-only (Viewer) Grafana service-account
 * tokens against pytorchci.grafana.net.
 *
 * Used by the `/api/gcx-token` route so contributors can self-serve a
 * `GRAFANA_TOKEN` for the `gcx` CLI without manually creating one in the
 * Grafana UI. Each GitHub user gets a dedicated service account named
 * `gcx-<github-login>` with the Viewer role; revocation is manual (delete the
 * token or the service account in the Grafana UI).
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

/**
 * Find-or-create the Viewer service account for `login` and mint a new
 * long-lived token on it. Returns the raw token key (the only time Grafana
 * ever exposes it).
 */
export async function mintGcxViewerToken(login: string): Promise<string> {
  const name = serviceAccountName(login);

  let saId = await findServiceAccountIdByName(name);
  if (saId == null) {
    saId = await createViewerServiceAccount(name);
  }

  // Long-lived (no secondsToLive); timestamp keeps the token name unique per SA.
  const tokenName = `${name}-${Date.now()}`;
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
