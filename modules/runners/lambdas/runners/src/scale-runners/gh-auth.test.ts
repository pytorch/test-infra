import { MockProxy, mock } from 'jest-mock-extended';
import { createGithubAuth, createOctoClient } from './gh-auth';

import { Config } from './config';
import { RequestInterface } from '@octokit/types';
import { createAppAuth } from '@octokit/auth-app';
import { decrypt } from './kms';
import nock from 'nock';
import { request } from '@octokit/request';

const secretString = JSON.stringify({
  github_app_key_base64: 'github_app_key_base64',
  github_app_id: 10,
  github_app_client_id: '20',
  github_app_client_secret: 'github_app_client_secret',
});

jest.mock('./kms');
jest.mock('@octokit/auth-app');

const mockSMgetSecretValuePromise = jest
  .fn()
  .mockResolvedValueOnce({ SecretString: undefined })
  .mockResolvedValueOnce({ SecretString: secretString });
const mockSMgetSecretValue = jest.fn().mockImplementation(() => ({ promise: mockSMgetSecretValuePromise }));
jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: mockSMgetSecretValue,
  })),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  nock.disableNetConnect();
});

describe('Test createOctoClient', () => {
  test('Creates app client to GitHub public', async () => {
    const token = '123456';

    const result = await createOctoClient(token);

    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');
  });

  test('Creates app client to GitHub ES', async () => {
    // Arrange
    const enterpriseServer = 'https://github.enterprise.notgoingtowork';
    const token = '123456';

    const result = await createOctoClient(token, enterpriseServer);

    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe(enterpriseServer);
    expect(result.request.endpoint.DEFAULTS.mediaType.previews).toStrictEqual(['antiope']);
  });
});

describe('Test createGithubAuth', () => {
  const mockedDecrypt = decrypt as unknown as jest.Mock;
  const mockedCreatAppAuth = createAppAuth as unknown as jest.Mock;
  const mockedDefaults = jest.spyOn(request, 'defaults');
  let mockedRequestInterface: MockProxy<RequestInterface>;

  const installationId = 1;
  const authType = 'app';
  const token = '123456';
  const clientSecret = 'clientSecret';
  const privateKeyBase64 = 'privateKeyBase64';
  const b64 = Buffer.from(privateKeyBase64, 'binary').toString('base64');
  const config = {
    environment: 'dev',
    githubAppClientId: '2',
    githubAppClientSecret: 'client_secret',
    githubAppId: '1',
    kmsKeyId: 'key_id',
  };

  describe('github keys are not from environment, nor secretsManagerSecretsId is provided', () => {
    beforeEach(() => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            ...config,
            secretsManagerSecretsId: undefined,
            githubAppClientSecret: undefined,
            githubAppId: undefined,
            githubAppClientId: undefined,
          } as unknown as Config),
      );
    });

    it('checks exception', async () => {
      expect(createGithubAuth(installationId, authType)).rejects.toThrowError();
    });
  });

  describe('using github keys from environment', () => {
    beforeEach(() => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            ...config,
            secretsManagerSecretsId: undefined,
          } as unknown as Config),
      );
    });

    test('Creates auth object for public GitHub', async () => {
      const authOptions = {
        appId: parseInt(config.githubAppId),
        privateKey: privateKeyBase64,
        installationId,
        clientId: config.githubAppClientId,
        clientSecret: clientSecret,
      };

      mockedDecrypt.mockResolvedValueOnce(clientSecret).mockResolvedValueOnce(b64);
      const mockedAuth = jest.fn();
      mockedAuth.mockResolvedValue({ token });
      mockedCreatAppAuth.mockImplementation(() => {
        return mockedAuth;
      });

      const result = await createGithubAuth(installationId, authType);

      expect(mockedDecrypt).toBeCalledWith(config.githubAppClientSecret, config.kmsKeyId, config.environment);
      expect(mockedDecrypt).toBeCalledWith(config.githubAppClientSecret, config.kmsKeyId, config.environment);
      expect(mockedCreatAppAuth).toBeCalledTimes(1);
      expect(mockedCreatAppAuth).toBeCalledWith(authOptions);
      expect(mockedAuth).toBeCalledWith({ type: authType });
      expect(result).toBe(token);
    });

    test('Creates auth object for Enterprise Server', async () => {
      const githubServerUrl = 'https://github.enterprise.notgoingtowork';

      mockedRequestInterface = mock<RequestInterface>();
      mockedDefaults.mockImplementation(() => {
        return mockedRequestInterface.defaults({ baseUrl: githubServerUrl });
      });

      const authOptions = {
        appId: parseInt(config.githubAppId),
        privateKey: privateKeyBase64,
        installationId,
        clientId: config.githubAppClientId,
        clientSecret: clientSecret,
        request: mockedRequestInterface.defaults({ baseUrl: githubServerUrl }),
      };

      mockedDecrypt.mockResolvedValueOnce(clientSecret).mockResolvedValueOnce(b64);
      const mockedAuth = jest.fn();
      mockedAuth.mockResolvedValue({ token });
      mockedCreatAppAuth.mockImplementation(() => {
        return mockedAuth;
      });

      const result = await createGithubAuth(installationId, authType, githubServerUrl);

      expect(mockedDecrypt).toBeCalledWith(config.githubAppClientSecret, config.kmsKeyId, config.environment);
      expect(mockedDecrypt).toBeCalledWith(config.githubAppClientSecret, config.kmsKeyId, config.environment);
      expect(mockedCreatAppAuth).toBeCalledTimes(1);
      expect(mockedCreatAppAuth).toBeCalledWith(authOptions);
      expect(mockedAuth).toBeCalledWith({ type: authType });
      expect(result).toBe(token);
    });

    test('Throws an error when cannot decrypt', async () => {
      mockedDecrypt.mockResolvedValue(undefined);

      await expect(createGithubAuth(installationId, authType)).rejects.toThrow(Error);
      expect(mockedCreatAppAuth).not.toHaveBeenCalled();
    });
  });

  describe('using github keys from SecretsManager', () => {
    beforeEach(() => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            ...config,
            secretsManagerSecretsId: 'Key ID',
          } as unknown as Config),
      );
    });

    test('Creates auth object twice for public GitHub', async () => {
      const authOptions = {
        appId: 10,
        privateKey: privateKeyBase64,
        installationId,
        clientId: '20',
        clientSecret: clientSecret,
      };

      mockedDecrypt
        .mockResolvedValueOnce(clientSecret)
        .mockResolvedValueOnce(b64)
        .mockResolvedValueOnce(clientSecret)
        .mockResolvedValueOnce(b64);
      const mockedAuth = jest.fn();
      mockedAuth.mockResolvedValue({ token });
      mockedCreatAppAuth.mockImplementation(() => {
        return mockedAuth;
      });

      await expect(createGithubAuth(installationId, authType)).rejects.toThrow('Issue grabbing secret');
      const result1 = await createGithubAuth(installationId, authType);
      const result2 = await createGithubAuth(installationId, authType);

      expect(mockSMgetSecretValue).toBeCalledTimes(2);
      expect(mockSMgetSecretValue).toHaveBeenCalledWith({ SecretId: Config.Instance.secretsManagerSecretsId });
      expect(mockSMgetSecretValuePromise).toBeCalledTimes(2);

      expect(mockedDecrypt).toBeCalledWith('github_app_client_secret', config.kmsKeyId, config.environment);
      expect(mockedDecrypt).toBeCalledWith('github_app_key_base64', config.kmsKeyId, config.environment);
      expect(mockSMgetSecretValuePromise).toBeCalledTimes(2);
      expect(mockedCreatAppAuth).toBeCalledWith(authOptions);
      expect(mockedAuth).toBeCalledWith({ type: authType });
      expect(result1).toBe(token);
      expect(result2).toBe(token);
    });
  });
});
