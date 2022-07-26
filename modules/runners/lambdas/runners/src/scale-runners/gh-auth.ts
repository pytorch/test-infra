import { Authentication, StrategyOptions } from '@octokit/auth-app/dist-types/types';

import { Config } from './config';
import { Octokit } from '@octokit/rest';
import { OctokitOptions } from '@octokit/core/dist-types/types';
import { SecretsManager } from 'aws-sdk';
import { createAppAuth } from '@octokit/auth-app';
import { decrypt } from './kms';
import { request } from '@octokit/request';

export interface GithubCredentials {
  github_app_key_base64: string;
  github_app_id: string;
  github_app_client_id: string;
  github_app_client_secret: string;
}

let secretCache: GithubCredentials | undefined = undefined;

async function getCredentialsFromSecretsManager(): Promise<GithubCredentials> {
  if (secretCache === undefined) {
    const secretsManager = new SecretsManager();
    const data = await secretsManager.getSecretValue({ SecretId: Config.Instance.secretsManagerSecretsId }).promise();
    if (data.SecretString === undefined) {
      throw Error('Issue grabbing secret');
    }
    secretCache = JSON.parse(data.SecretString as string) as GithubCredentials;
  }

  return secretCache;
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
  const githubCreds: GithubCredentials =
    Config.Instance.secretsManagerSecretsId !== undefined
      ? await getCredentialsFromSecretsManager()
      : {
          github_app_key_base64: Config.Instance.githubAppClientSecret,
          github_app_id: Config.Instance.githubAppId,
          github_app_client_id: Config.Instance.githubAppClientId,
          github_app_client_secret: Config.Instance.githubAppClientSecret,
        };

  /* istanbul ignore next */
  const clientSecret = Config.Instance.kmsKeyId
    ? await decrypt(githubCreds.github_app_client_secret, Config.Instance.kmsKeyId, Config.Instance.environment)
    : githubCreds.github_app_client_secret;

  /* istanbul ignore next */
  const privateKeyBase64 = Config.Instance.kmsKeyId
    ? await decrypt(githubCreds.github_app_key_base64, Config.Instance.kmsKeyId, Config.Instance.environment)
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

  return await createAppAuth(authOptions)({ type: authType });
}
