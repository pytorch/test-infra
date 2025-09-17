import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import jwt from "jsonwebtoken";
import { RateLimiter } from "../utils/rateLimiter";

export interface GithubAppSecret {
  github_app_client_id?: string;
  github_app_id: string;
  github_app_client_secret?: string;
  github_app_key_base64: string; // base64-encoded PEM
}

interface CachedSecret {
  secret: GithubAppSecret;
  expiresAt: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class GitHubClient {
  private cachedSecret: CachedSecret | null = null;
  private cachedInstallationToken: CachedToken | null = null;
  private readonly rateLimiter: RateLimiter;
  private readonly secrets: SecretsManagerClient;
  private readonly githubRepo: string;
  private readonly githubAppSecretId: string;

  constructor(githubRepo: string, githubAppSecretId: string, requestsPerSecond: number = 10) {
    this.githubRepo = githubRepo;
    this.githubAppSecretId = githubAppSecretId;
    this.rateLimiter = new RateLimiter(requestsPerSecond);
    this.secrets = new SecretsManagerClient({});
  }

  private nowEpochSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  private async loadGithubSecret(): Promise<GithubAppSecret> {
    // Check if we have a valid cached secret
    const now = this.nowEpochSeconds();
    if (this.cachedSecret && this.cachedSecret.expiresAt > now) {
      return this.cachedSecret.secret;
    }

    if (!this.githubAppSecretId) {
      throw new Error("GITHUB_APP_SECRET_ID not set");
    }

    try {
      const res = await this.secrets.send(
        new GetSecretValueCommand({ SecretId: this.githubAppSecretId })
      );
      const secretString = res.SecretString;
      if (!secretString) throw new Error("SecretString empty for GitHub App secret");

      const parsed = JSON.parse(secretString) as GithubAppSecret;
      if (!parsed.github_app_id || !parsed.github_app_key_base64) {
        throw new Error("GitHub App secret missing required fields (github_app_id, github_app_key_base64)");
      }

      // Cache secret TTL to 5 minutes for security
      this.cachedSecret = {
        secret: parsed,
        expiresAt: now + 300, // 5 minutes
      };

      return parsed;
    } catch (error) {
      // Clear cached secret on error to force refresh next time
      this.cachedSecret = null;
      throw error;
    }
  }

  private buildAppJwt(appId: string, pemKeyBase64: string): string {
    const pem = Buffer.from(pemKeyBase64, "base64").toString("utf8");
    const iat = this.nowEpochSeconds() - 30; // clock skew
    const exp = iat + 9 * 60; // 9 minutes
    return jwt.sign(
      { iat, exp, iss: appId },
      pem,
      { algorithm: "RS256" }
    );
  }

  private async getInstallationToken(): Promise<string> {
    // reuse cached token if valid for >60s
    if (this.cachedInstallationToken && this.cachedInstallationToken.expiresAt - this.nowEpochSeconds() > 60) {
      return this.cachedInstallationToken.token;
    }
    if (!this.githubRepo) throw new Error("GITHUB_REPO not set");
    const [owner, repo] = this.githubRepo.split("/");
    if (!owner || !repo) throw new Error("GITHUB_REPO must be in the form org/repo");
    const secret = await this.loadGithubSecret();
    const appJwt = this.buildAppJwt(secret.github_app_id, secret.github_app_key_base64);

    const ghHeaders = {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pytorch-alerting"
    } as const;

    // Discover installation id for the repo
    const instResp = await this.rateLimiter.execute(async () =>
      fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
        method: "GET",
        headers: ghHeaders,
      })
    );
    if (instResp.status === 404) {
      throw new Error(`GitHub App is not installed on ${this.githubRepo}`);
    }
    if (!instResp.ok) {
      // Security: Don't log full response body which might contain sensitive data
      const errorInfo = `${instResp.status} ${instResp.statusText}`;
      throw new Error(`Failed to get installation: ${errorInfo}`);
    }
    const instData = await instResp.json() as { id: number };

    // Mint installation token
    const tokenResp = await this.rateLimiter.execute(async () =>
      fetch(`https://api.github.com/app/installations/${instData.id}/access_tokens`, {
        method: "POST",
        headers: ghHeaders,
      })
    );
    if (!tokenResp.ok) {
      // Security: Don't log full response body which might contain sensitive data
      const errorInfo = `${tokenResp.status} ${tokenResp.statusText}`;
      throw new Error(`Failed to create installation token: ${errorInfo}`);
    }
    const tokenData = await tokenResp.json() as { token: string; expires_at: string };
    this.cachedInstallationToken = {
      token: tokenData.token,
      expiresAt: Math.floor(new Date(tokenData.expires_at).getTime() / 1000),
    };
    return this.cachedInstallationToken.token;
  }

  async ensureGithubLabel(owner: string, repo: string, token: string, labelName: string, color: string = "0969da"): Promise<void> {
    // Check if label exists
    const checkResp = await this.rateLimiter.execute(async () =>
      fetch(`https://api.github.com/repos/${owner}/${repo}/labels/${encodeURIComponent(labelName)}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "pytorch-alerting",
        },
      })
    );

    if (checkResp.status === 404) {
      // Label doesn't exist, create it
      const createResp = await this.rateLimiter.execute(async () =>
        fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pytorch-alerting",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: labelName,
            color: color,
            description: `Alert label for ${labelName}`,
          }),
        })
      );

      if (!createResp.ok) {
        // Security: Don't log full response body which might contain sensitive data
        const errorInfo = `${createResp.status} ${createResp.statusText}`;
        console.warn(`Failed to create label ${labelName}: ${errorInfo}`);
        // Don't throw - label creation failure shouldn't fail the whole process
      } else {
        console.log(`✅ Created GitHub label: ${labelName}`);
      }
    } else if (!checkResp.ok) {
      // Security: Don't log full response body which might contain sensitive data
      const errorInfo = `${checkResp.status} ${checkResp.statusText}`;
      console.warn(`Failed to check label ${labelName}: ${errorInfo}`);
    }
  }

  async createGithubIssue(title: string, body: string, labels: string[]): Promise<number> {
    if (!this.githubRepo) throw new Error("GITHUB_REPO not set");
    const [owner, repo] = this.githubRepo.split("/");
    const token = await this.getInstallationToken();


    const resp = await this.rateLimiter.execute(async () =>
      fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "pytorch-alerting",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body, labels }),
      })
    );
    if (!resp.ok) {
      // Security: Don't log full response body which might contain sensitive data
      const errorInfo = `${resp.status} ${resp.statusText}`;
      throw new Error(`Failed to create issue: ${errorInfo}`);
    }
    const data = await resp.json() as { number: number };
    return data.number;
  }
}