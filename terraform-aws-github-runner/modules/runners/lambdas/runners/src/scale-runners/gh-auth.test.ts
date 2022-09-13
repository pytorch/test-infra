import { MockProxy, mock } from 'jest-mock-extended';
import { createGithubAuth, createOctoClient, resetSecretCache } from './gh-auth';

import { Config } from './config';
import { RequestInterface } from '@octokit/types';
import { createAppAuth } from '@octokit/auth-app';
import { decrypt } from './kms';
import { ScaleUpMetrics } from './metrics';
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

const mockSMgetSecretValuePromise = jest.fn();
const mockSMgetSecretValue = jest.fn();
jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: mockSMgetSecretValue,
  })),
  CloudWatch: jest.requireActual('aws-sdk').CloudWatch,
}));

const metrics = new ScaleUpMetrics();

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();

  jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {
    return;
  });
});

describe('Test createOctoClient', () => {
  test('Creates app client to GitHub public', async () => {
    const token = '123456';

    const result = createOctoClient(token);

    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');
  });

  test('Creates app client to GitHub ES', async () => {
    // Arrange
    const enterpriseServer = 'https://github.enterprise.notgoingtowork';
    const token = '123456';

    const result = createOctoClient(token, enterpriseServer);

    expect(result.request.endpoint.DEFAULTS.baseUrl).toBe(enterpriseServer);
    expect(result.request.endpoint.DEFAULTS.mediaType.previews).toStrictEqual(['antiope']);
  });
});

describe('Test createGithubAuth', () => {
  const mockedDecrypt = decrypt as unknown as jest.Mock;
  const mockedCreatAppAuth = createAppAuth as unknown as jest.Mock;
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

  describe('tests where aws-sdk fails', () => {
    const message = 'Error message on exception';
    beforeEach(() => {
      mockSMgetSecretValuePromise.mockClear().mockRejectedValue(Error(message));
      mockSMgetSecretValue.mockClear().mockImplementation(() => ({ promise: mockSMgetSecretValuePromise }));

      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            ...config,
            secretsManagerSecretsId: 'Key ID',
          } as unknown as Config),
      );
    });

    it('captures the exception', async () => {
      resetSecretCache();
      await expect(createGithubAuth(installationId, authType, '', new ScaleUpMetrics())).rejects.toThrowError(message);
    });
  });

  describe('tests where aws-sdk works as expected', () => {
    beforeEach(() => {
      mockSMgetSecretValuePromise
        .mockClear()
        .mockResolvedValueOnce({ SecretString: undefined })
        .mockResolvedValueOnce({ SecretString: secretString });
      mockSMgetSecretValue.mockClear().mockImplementation(() => ({ promise: mockSMgetSecretValuePromise }));
    });

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
        resetSecretCache();
        await expect(createGithubAuth(installationId, authType, '', new ScaleUpMetrics())).rejects.toThrowError();
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
        mockedAuth.mockResolvedValue({
          token,
          type: 'type',
          tokenType: 'tokenType',
          expiresAt: 'expiresAt',
          installationId: 'installationId',
        });
        mockedCreatAppAuth.mockImplementation(() => {
          return mockedAuth;
        });

        resetSecretCache();
        const result = await createGithubAuth(installationId, authType, '', metrics);

        expect(mockedDecrypt).toBeCalledWith(
          config.githubAppClientSecret,
          config.kmsKeyId,
          config.environment,
          metrics,
        );
        expect(mockedDecrypt).toBeCalledWith(
          config.githubAppClientSecret,
          config.kmsKeyId,
          config.environment,
          metrics,
        );
        expect(mockedCreatAppAuth).toBeCalledTimes(1);
        expect(mockedCreatAppAuth).toBeCalledWith(authOptions);
        expect(mockedAuth).toBeCalledWith({ type: authType });
        expect(result).toBe(token);
      });

      test('Creates auth object for Enterprise Server', async () => {
        const mockedDefaults = jest.spyOn(request, 'defaults');
        const githubServerUrl = 'https://github.enterprise.notgoingtowork';

        mockedRequestInterface = mock<RequestInterface>();
        mockedDefaults.mockImplementation(() => {
          console.error('mockedDefaults.mockImplementation -> mockedRequestInterface.defaults');
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

        resetSecretCache();
        const result = await createGithubAuth(installationId, authType, githubServerUrl, metrics);

        expect(mockedDecrypt).toBeCalledWith(
          config.githubAppClientSecret,
          config.kmsKeyId,
          config.environment,
          metrics,
        );
        expect(mockedDecrypt).toBeCalledWith(
          config.githubAppClientSecret,
          config.kmsKeyId,
          config.environment,
          metrics,
        );
        expect(mockedCreatAppAuth).toBeCalledTimes(1);
        expect(mockedCreatAppAuth).toBeCalledWith(authOptions);
        expect(mockedAuth).toBeCalledWith({ type: authType });
        expect(result).toBe(token);
      });

      test('Throws an error when cannot decrypt', async () => {
        mockedDecrypt.mockResolvedValue(undefined);

        await expect(createGithubAuth(installationId, authType, '', new ScaleUpMetrics())).rejects.toThrow(Error);
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

        resetSecretCache();
        await expect(createGithubAuth(installationId, authType, '', new ScaleUpMetrics())).rejects.toThrow(
          'Issue grabbing secret',
        );
        const result1 = await createGithubAuth(installationId, authType, '', metrics);
        const result2 = await createGithubAuth(installationId, authType, '', metrics);

        expect(mockSMgetSecretValue).toBeCalledTimes(2);
        expect(mockSMgetSecretValue).toHaveBeenCalledWith({ SecretId: Config.Instance.secretsManagerSecretsId });
        expect(mockSMgetSecretValuePromise).toBeCalledTimes(2);

        expect(mockedDecrypt).toBeCalledWith('github_app_client_secret', config.kmsKeyId, config.environment, metrics);
        expect(mockedDecrypt).toBeCalledWith('github_app_key_base64', config.kmsKeyId, config.environment, metrics);
        expect(mockSMgetSecretValuePromise).toBeCalledTimes(2);
        expect(mockedCreatAppAuth).toBeCalledWith(authOptions);
        expect(mockedAuth).toBeCalledWith({ type: authType });
        expect(result1).toBe(token);
        expect(result2).toBe(token);
      });
    });
  });
});
