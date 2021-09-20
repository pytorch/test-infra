import { Octokit } from '@octokit/rest';
import { request } from '@octokit/request';
import { createAppAuth } from '@octokit/auth-app';
import { Authentication, StrategyOptions } from '@octokit/auth-app/dist-types/types';
import { OctokitOptions } from '@octokit/core/dist-types/types';
import { decrypt } from './kms';
import LRU from 'lru-cache';
import { SecretsManager } from 'aws-sdk';

export interface GithubCredentials {
  github_app_key_base64: string;
  github_app_id: string;
  github_app_client_id: string;
  github_app_client_secret: string;
}

const secretCache = new LRU();

async function getCredentialsFromSecretsManager(): Promise<GithubCredentials> {
  const secretID = process.env.SECRETSMANAGER_SECRETS_ID as string;
  if (secretCache.get(secretID) !== undefined) {
    return secretCache.get(secretID) as GithubCredentials;
  }
  const secretsManager = new SecretsManager();
  console.debug(`Grabbing secrets from ${secretID}`);
  const data = await secretsManager.getSecretValue({ SecretId: secretID }).promise();
  if (data.SecretString === undefined) {
    throw Error('Issue grabbing secret');
  }
  secretCache.set(secretID, JSON.parse(data.SecretString as string) as GithubCredentials);
  return secretCache.get(secretID) as GithubCredentials;
}

export async function createOctoClient(token: string, ghesApiUrl = ''): Promise<Octokit> {
  const ocktokitOptions: OctokitOptions = {
    auth: token,
  };
  if (ghesApiUrl) {
    ocktokitOptions.baseUrl = ghesApiUrl;
    ocktokitOptions.previews = ['antiope'];
  }
  return new Octokit(ocktokitOptions);
}

export async function createGithubAuth(
  installationId: number | undefined,
  authType: 'app' | 'installation',
  ghesApiUrl = '',
): Promise<Authentication> {
  let githubCreds: GithubCredentials;
  // Option to grab secrets from secrets manager
  if (process.env.SECRETSMANAGER_SECRETS_ID !== undefined) {
    githubCreds = await getCredentialsFromSecretsManager();
  } else {
    githubCreds = {
      github_app_key_base64: process.env.GITHUB_APP_CLIENT_SECRET as string,
      github_app_id: process.env.GITHUB_APP_ID as string,
      github_app_client_id: process.env.GITHUB_APP_CLIENT_ID as string,
      github_app_client_secret: process.env.GITHUB_APP_CLIENT_SECRET as string,
    };
  }
  const clientSecret = await decrypt(
    githubCreds.github_app_client_secret,
    process.env.KMS_KEY_ID as string,
    process.env.ENVIRONMENT as string,
  );
  const privateKeyBase64 = await decrypt(
    githubCreds.github_app_key_base64,
    process.env.KMS_KEY_ID as string,
    process.env.ENVIRONMENT as string,
  );

  if (clientSecret === undefined || privateKeyBase64 === undefined) {
    throw Error('Cannot decrypt.');
  }

  const privateKey = Buffer.from(privateKeyBase64, 'base64').toString();

  const appId: number = parseInt(githubCreds.github_app_id);
  const clientId = githubCreds.github_app_client_id as string;

  const authOptions: StrategyOptions = {
    appId,
    privateKey,
    installationId,
    clientId,
    clientSecret,
  };
  console.debug(ghesApiUrl);
  if (ghesApiUrl) {
    authOptions.request = request.defaults({
      baseUrl: ghesApiUrl,
    });
  }
  return await createAppAuth(authOptions)({ type: authType });
}
