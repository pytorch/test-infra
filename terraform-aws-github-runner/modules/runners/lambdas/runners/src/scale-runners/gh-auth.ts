import { Config } from './config';
import LRU from 'lru-cache';
import { Octokit } from '@octokit/rest';
import { OctokitOptions } from '@octokit/core/dist-types/types';
import { SecretsManager } from 'aws-sdk';
import { StrategyOptions } from '@octokit/auth-app/dist-types/types';
import { createAppAuth } from '@octokit/auth-app';
import { decrypt } from './kms';
import { request } from '@octokit/request';
import { Metrics } from './metrics';

export interface GithubCredentials {
  github_app_key_base64: string;
  github_app_id: string;
  github_app_client_id: string;
  github_app_client_secret: string;
}

const secretCache = new LRU({ maxAge: 5 * 60 * 1000 });

export function resetSecretCache() {
  secretCache.reset();
}

async function getCredentialsFromSecretsManager(
  secretsManagerSecretsId: string,
  metrics: Metrics,
): Promise<GithubCredentials> {
  try {
    let secret = secretCache.get(secretsManagerSecretsId) as GithubCredentials;

    if (secret === undefined) {
      const secretsManager = new SecretsManager();
      const data = await metrics.trackRequest(
        metrics.smGetSecretValueAWSCallSuccess,
        metrics.smGetSecretValueAWSCallFailure,
        () => {
          return secretsManager.getSecretValue({ SecretId: secretsManagerSecretsId }).promise();
        },
      );
      if (data.SecretString === undefined) {
        throw Error('Issue grabbing secret');
      }
      secret = JSON.parse(data.SecretString as string) as GithubCredentials;
      secretCache.set(secretsManagerSecretsId, secret);
    }

    return secret;
  } catch (e) {
    console.error(`[getCredentialsFromSecretsManager]: ${e}`);
    throw e;
  }
}

export function createOctoClient(token: string, ghesApiUrl = ''): Octokit {
  const ocktokitOptions: OctokitOptions = {
    auth: token,
  };
  if (ghesApiUrl) {
    ocktokitOptions.baseUrl = ghesApiUrl;
    ocktokitOptions.previews = ['antiope'];
  }
  return new Octokit(ocktokitOptions);
}

async function getGithubCredentials(metrics: Metrics): Promise<GithubCredentials> {
  if (Config.Instance.secretsManagerSecretsId !== undefined) {
    return await getCredentialsFromSecretsManager(Config.Instance.secretsManagerSecretsId, metrics);
  }
  if (
    Config.Instance.githubAppClientSecret === undefined ||
    Config.Instance.githubAppId === undefined ||
    Config.Instance.githubAppClientId === undefined
  ) {
    throw Error(
      "Either 'secretsManagerSecretsId' or all of 'githubAppClientSecret, " +
        "githubAppId, githubAppClientId' must be defined",
    );
  }
  return {
    github_app_key_base64: Config.Instance.githubAppClientSecret as string,
    github_app_id: Config.Instance.githubAppId as string,
    github_app_client_id: Config.Instance.githubAppClientId as string,
    github_app_client_secret: Config.Instance.githubAppClientSecret as string,
  };
}

export async function createGithubAuth(
  installationId: number | undefined,
  authType: 'app' | 'installation',
  ghesApiUrl = '',
  metrics: Metrics,
): Promise<string> {
  try {
    const githubCreds = await getGithubCredentials(metrics);

    /* istanbul ignore next */
    const clientSecret = Config.Instance.kmsKeyId
      ? await decrypt(
          githubCreds.github_app_client_secret,
          Config.Instance.kmsKeyId as string,
          Config.Instance.environment,
          metrics,
        )
      : githubCreds.github_app_client_secret;

    /* istanbul ignore next */
    const privateKeyBase64 = Config.Instance.kmsKeyId
      ? await decrypt(
          githubCreds.github_app_key_base64,
          Config.Instance.kmsKeyId as string,
          Config.Instance.environment,
          metrics,
        )
      : githubCreds.github_app_key_base64;

    if (clientSecret === undefined || privateKeyBase64 === undefined) {
      throw Error('Cannot decrypt.');
    }

    const authOptions: StrategyOptions = {
      appId: parseInt(githubCreds.github_app_id),
      privateKey: Buffer.from(privateKeyBase64, 'base64').toString(),
      installationId,
      clientId: githubCreds.github_app_client_id as string,
      clientSecret,
    };

    if (ghesApiUrl) {
      authOptions.request = request.defaults({
        baseUrl: ghesApiUrl,
      });
    }

    const auth = await metrics.trackRequest(
      metrics.createAppAuthGHCallSuccess,
      metrics.createAppAuthGHCallFailure,
      () => {
        return createAppAuth(authOptions)({ type: authType });
      },
    );

    let tokenDisplayInfo = '';
    if (auth.type !== undefined) tokenDisplayInfo += ` Type: ${auth.type}`;
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    if ((auth as any).tokenType !== undefined) tokenDisplayInfo += ` TokenType: ${(auth as any).tokenType}`;
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    if ((auth as any).expiresAt !== undefined) tokenDisplayInfo += ` ExpiresAt: ${(auth as any).expiresAt}`;
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    if ((auth as any).installationId !== undefined) {
      // eslint-disable-next-line  @typescript-eslint/no-explicit-any
      tokenDisplayInfo += ` InstallationId: ${(auth as any).installationId}`;
    }

    if (tokenDisplayInfo) {
      console.debug(`[createGithubAuth] Created token with:${tokenDisplayInfo}`);
    }

    return auth.token;
  } catch (e) {
    console.error(`[createGithubAuth]: ${e}`);
    throw e;
  }
}
