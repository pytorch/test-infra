import {
  GhRunners,
  createGitHubClientForRunnerInstallId,
  createGitHubClientForRunnerOrg,
  createGitHubClientForRunnerRepo,
  createRegistrationTokenOrg,
  createRegistrationTokenRepo,
  getRunnerOrg,
  getRunnerRepo,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetGHRunnersCaches,
} from './gh-runners';
import { createGithubAuth, createOctoClient } from './gh-auth';
import { ScaleUpMetrics } from './metrics';

import { Config } from './config';
import { Octokit } from '@octokit/rest';
import { mocked } from 'ts-jest/utils';
import { locallyCached } from './cache';
import nock from 'nock';

const mockEC2 = {
  describeInstances: jest.fn(),
  runInstances: jest.fn(),
  terminateInstances: jest.fn().mockReturnValue({ promise: jest.fn() }),
};
const mockSSMdescribeParametersRet = jest.fn();
const mockSSM = {
  deleteParameter: jest.fn().mockReturnValue({ promise: jest.fn() }),
  describeParameters: jest.fn().mockReturnValue({ promise: mockSSMdescribeParametersRet }),
  putParameter: jest.fn().mockReturnValue({ promise: jest.fn() }),
};
jest.mock('aws-sdk', () => ({
  EC2: jest.fn().mockImplementation(() => mockEC2),
  SSM: jest.fn().mockImplementation(() => mockSSM),
  CloudWatch: jest.requireActual('aws-sdk').CloudWatch,
}));

jest.mock('./gh-auth');
jest.mock('./cache', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./cache') as any),
  redisClearCacheKeyPattern: jest.fn(),
  redisCached: jest
    .fn()
    .mockImplementation(async <T>(ns: string, k: string, t: number, j: number, fn: () => Promise<T>): Promise<T> => {
      return await locallyCached(ns, k, t, fn);
    }),
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

describe('resetGHRunnersCaches', () => {
  const config = {
    ghesUrlApi: 'ghesUrl/api/v3',
  };
  const irrelevantRunner: GhRunners = [
    {
      id: 1,
      name: 'name',
      os: 'linux',
      status: 'busy',
      busy: true,
      labels: [],
    },
  ];

  beforeEach(() => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
  });

  it('checks if cache is reset', async () => {
    const repo = { owner: 'owner', repo: 'repo' };
    const mockCreateGithubAuth = mocked(createGithubAuth);
    const mockCreateOctoClient = mocked(createOctoClient);
    const getRepoInstallation = jest.fn().mockResolvedValue({
      data: { id: 'mockReturnValueOnce1' },
    });
    const expectedReturn = {
      actions: { listSelfHostedRunnersForRepo: '' },
      apps: { getRepoInstallation: getRepoInstallation },
      paginate: jest.fn().mockResolvedValue(irrelevantRunner),
    };

    for (let i = 0; i < 2; i++) {
      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValue(expectedReturn as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValue(expectedReturn as unknown as Octokit);
    }

    await resetGHRunnersCaches();
    expect(await listGithubRunnersRepo(repo, metrics)).toEqual(irrelevantRunner);
    expect(await createGitHubClientForRunnerRepo(repo, metrics)).toEqual(expectedReturn);

    await resetGHRunnersCaches();
    expect(await listGithubRunnersRepo(repo, metrics)).toEqual(irrelevantRunner);
    expect(await createGitHubClientForRunnerRepo(repo, metrics)).toEqual(expectedReturn);

    expect(expectedReturn.paginate).toBeCalledTimes(2);
    expect(mockCreateGithubAuth).toHaveBeenCalledTimes(4);
    expect(mockCreateOctoClient).toHaveBeenCalledTimes(4);
  });
});

describe('createGitHubClientForRunner variants', () => {
  const config = {
    ghesUrlApi: undefined,
  };

  beforeEach(() => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
  });

  describe('createGitHubClientForRunnerRepo', () => {
    it('createOctoClient fails', async () => {
      const errMsg = 'Error message';
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockImplementation(() => {
        throw Error(errMsg);
      });

      await resetGHRunnersCaches();
      await expect(createGitHubClientForRunnerRepo(repo, metrics)).rejects.toThrowError(errMsg);
    });

    it('getRepoInstallation fails', async () => {
      const errMsg = 'Error message';
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const expectedReturn = {
        apps: { getRepoInstallation: jest.fn().mockRejectedValueOnce(Error(errMsg)) },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValue(expectedReturn as unknown as Octokit);

      await resetGHRunnersCaches();
      await expect(createGitHubClientForRunnerRepo(repo, metrics)).rejects.toThrowError(errMsg);
    });

    it('runs twice and check if cached', async () => {
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn().mockResolvedValueOnce({
        data: { id: 'mockReturnValueOnce1' },
      });
      const expectedReturn = {
        apps: { getRepoInstallation: getRepoInstallation },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce({
        apps: { getRepoInstallation: getRepoInstallation },
      } as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(expectedReturn as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await createGitHubClientForRunnerRepo(repo, metrics)).toEqual(expectedReturn);
      expect(await createGitHubClientForRunnerRepo(repo, metrics)).toEqual(expectedReturn);

      expect(mockCreateGithubAuth).toHaveBeenCalledTimes(2);
      expect(mockCreateOctoClient).toHaveBeenCalledTimes(2);

      expect(mockCreateGithubAuth).toHaveBeenCalledWith(undefined, 'app', undefined, metrics);
      expect(mockCreateOctoClient).toHaveBeenCalledWith('token1', undefined);
      expect(getRepoInstallation).toHaveBeenCalledWith(repo);
      expect(mockCreateGithubAuth).toHaveBeenCalledWith('mockReturnValueOnce1', 'installation', undefined, metrics);
      expect(mockCreateOctoClient).toHaveBeenCalledWith('token2', undefined);
    });
  });

  describe('createGitHubClientForRunnerOrg', () => {
    it('runs twice and check if cached', async () => {
      const org = 'MockedOrg';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn().mockResolvedValueOnce({
        data: { id: 'mockReturnValueOnce1' },
      });
      const expectedReturn = {
        apps: { getOrgInstallation: getOrgInstallation },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce({
        apps: { getOrgInstallation: getOrgInstallation },
      } as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(expectedReturn as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await createGitHubClientForRunnerOrg(org, metrics)).toEqual(expectedReturn);
      expect(await createGitHubClientForRunnerOrg(org, metrics)).toEqual(expectedReturn);

      expect(mockCreateGithubAuth).toHaveBeenCalledTimes(2);
      expect(mockCreateOctoClient).toHaveBeenCalledTimes(2);

      expect(mockCreateGithubAuth).toHaveBeenCalledWith(undefined, 'app', undefined, metrics);
      expect(mockCreateOctoClient).toHaveBeenCalledWith('token1', undefined);
      expect(getOrgInstallation).toHaveBeenCalledWith({ org: org });
      expect(mockCreateGithubAuth).toHaveBeenCalledWith('mockReturnValueOnce1', 'installation', undefined, metrics);
      expect(mockCreateOctoClient).toHaveBeenCalledWith('token2', undefined);
    });

    it('getOrgInstallation fails', async () => {
      const errMsg = 'Error message';
      const org = 'MockedOrg';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const expectedReturn = {
        apps: { getOrgInstallation: jest.fn().mockRejectedValueOnce(Error(errMsg)) },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(expectedReturn as unknown as Octokit);

      await resetGHRunnersCaches();
      await expect(createGitHubClientForRunnerOrg(org, metrics)).rejects.toThrowError(errMsg);
    });
  });

  describe('createGitHubClientForRunnerInstallId', () => {
    it('runs twice and check if cached', async () => {
      const installId = 113;
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const expectedReturn = {
        apps: {},
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(expectedReturn as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await createGitHubClientForRunnerInstallId(installId, metrics)).toEqual(expectedReturn);
      expect(await createGitHubClientForRunnerInstallId(installId, metrics)).toEqual(expectedReturn);

      expect(mockCreateGithubAuth).toHaveBeenCalledTimes(1);
      expect(mockCreateOctoClient).toHaveBeenCalledTimes(1);

      expect(mockCreateGithubAuth).toHaveBeenCalledWith(installId, 'installation', undefined, metrics);
      expect(mockCreateOctoClient).toHaveBeenCalledWith('token2', undefined);
    });

    it('createOctoClient fails', async () => {
      const errMsg = 'Error message';
      const installId = 113;
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockImplementation(() => {
        throw Error(errMsg);
      });

      await resetGHRunnersCaches();
      await expect(createGitHubClientForRunnerInstallId(installId, metrics)).rejects.toThrowError(errMsg);
    });
  });
});

describe('listGithubRunners', () => {
  const irrelevantRunner: GhRunners = [
    {
      id: 1,
      name: 'name',
      os: 'linux',
      status: 'busy',
      busy: true,
      labels: [],
    },
  ];

  describe('listGithubRunnersRepo', () => {
    it('runs twice and check if cached', async () => {
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: { listSelfHostedRunnersForRepo: '' },
        apps: { getRepoInstallation: getRepoInstallation },
        paginate: jest.fn().mockResolvedValue(irrelevantRunner),
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await listGithubRunnersRepo(repo, metrics)).toEqual(irrelevantRunner);
      expect(await listGithubRunnersRepo(repo, metrics)).toEqual(irrelevantRunner);

      expect(mockedOctokit.paginate).toBeCalledTimes(1);
      expect(mockedOctokit.paginate).toBeCalledWith(mockedOctokit.actions.listSelfHostedRunnersForRepo, {
        ...repo,
        per_page: 100,
      });
    });

    it('paginate fails', async () => {
      const errMsg = 'Error message';
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: { listSelfHostedRunnersForRepo: '' },
        apps: { getRepoInstallation: getRepoInstallation },
        paginate: jest.fn().mockRejectedValue(Error(errMsg)),
      };

      mockCreateGithubAuth.mockResolvedValue('token1');
      mockCreateOctoClient.mockReturnValue(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      await expect(listGithubRunnersRepo(repo, metrics)).rejects.toThrowError(errMsg);
    });
  });

  describe('listGithubRunnersOrg', () => {
    it('runs twice and check if cached', async () => {
      const org = 'mocked_org';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: { listSelfHostedRunnersForOrg: 'XxXxX' },
        apps: { getOrgInstallation: getOrgInstallation },
        paginate: jest.fn().mockResolvedValue(irrelevantRunner),
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await listGithubRunnersOrg(org, metrics)).toEqual(irrelevantRunner);
      expect(await listGithubRunnersOrg(org, metrics)).toEqual(irrelevantRunner);

      expect(mockedOctokit.paginate).toBeCalledTimes(1);
      expect(mockedOctokit.paginate).toBeCalledWith(mockedOctokit.actions.listSelfHostedRunnersForOrg, {
        org: org,
        per_page: 100,
      });
    });

    it('paginate fails', async () => {
      const errMsg = 'Error message';
      const org = 'mocked_org';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: { listSelfHostedRunnersForOrg: 'XxXxX' },
        apps: { getOrgInstallation: getOrgInstallation },
        paginate: jest.fn().mockRejectedValueOnce(Error(errMsg)),
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      await expect(listGithubRunnersOrg(org, metrics)).rejects.toThrowError(errMsg);
    });
  });
});

describe('removeGithubRunnerRepo', () => {
  it('succeeds', async () => {
    const runnerId = 33;
    const repo = { owner: 'owner', repo: 'repo' };
    const mockCreateGithubAuth = mocked(createGithubAuth);
    const mockCreateOctoClient = mocked(createOctoClient);
    const getRepoInstallation = jest.fn().mockResolvedValue({
      data: { id: 'mockReturnValueOnce1' },
    });
    const mockedOctokit = {
      actions: {
        deleteSelfHostedRunnerFromRepo: jest.fn().mockResolvedValue({
          status: 204,
        }),
      },
      apps: { getRepoInstallation: getRepoInstallation },
    };

    mockCreateGithubAuth.mockResolvedValueOnce('token1');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce('token2');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    await resetGHRunnersCaches();
    await removeGithubRunnerRepo(runnerId, repo, metrics);

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromRepo).toBeCalledWith({
      ...repo,
      runner_id: runnerId,
    });
    expect(getRepoInstallation).toBeCalled();
  });

  it('fails', async () => {
    const runnerId = 33;
    const repo = { owner: 'owner', repo: 'repo' };
    const mockCreateGithubAuth = mocked(createGithubAuth);
    const mockCreateOctoClient = mocked(createOctoClient);
    const getRepoInstallation = jest.fn().mockResolvedValue({
      data: { id: 'mockReturnValueOnce1' },
    });
    const mockedOctokit = {
      actions: {
        deleteSelfHostedRunnerFromRepo: jest.fn().mockImplementation(() => {
          throw Error('error');
        }),
      },
      apps: { getRepoInstallation: getRepoInstallation },
    };

    mockCreateGithubAuth.mockResolvedValueOnce('token1');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce('token2');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    await resetGHRunnersCaches();
    await expect(removeGithubRunnerRepo(runnerId, repo, metrics)).rejects.toThrow();

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromRepo).toBeCalledWith({
      ...repo,
      runner_id: runnerId,
    });
    expect(getRepoInstallation).toBeCalled();
  });
});

describe('removeGithubRunnerOrg', () => {
  const org = 'mockedOrg';

  it('succeeds', async () => {
    const runnerId = 33;
    const mockCreateGithubAuth = mocked(createGithubAuth);
    const mockCreateOctoClient = mocked(createOctoClient);
    const getOrgInstallation = jest.fn().mockResolvedValue({
      data: { id: 'mockReturnValueOnce1' },
    });
    const mockedOctokit = {
      actions: {
        deleteSelfHostedRunnerFromOrg: jest.fn().mockResolvedValue({
          status: 204,
        }),
      },
      apps: { getOrgInstallation: getOrgInstallation },
    };

    mockCreateGithubAuth.mockResolvedValueOnce('token1');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce('token2');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    await resetGHRunnersCaches();
    await removeGithubRunnerOrg(runnerId, org, metrics);

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromOrg).toBeCalledWith({
      org: org,
      runner_id: runnerId,
    });
    expect(getOrgInstallation).toBeCalled();
  });

  it('fails', async () => {
    const runnerId = 33;
    const mockCreateGithubAuth = mocked(createGithubAuth);
    const mockCreateOctoClient = mocked(createOctoClient);
    const getOrgInstallation = jest.fn().mockResolvedValue({
      data: { id: 'mockReturnValueOnce1' },
    });
    const mockedOctokit = {
      actions: {
        deleteSelfHostedRunnerFromOrg: jest.fn().mockImplementation(() => {
          throw Error('error');
        }),
      },
      apps: { getOrgInstallation: getOrgInstallation },
    };

    mockCreateGithubAuth.mockResolvedValueOnce('token1');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce('token2');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    await resetGHRunnersCaches();
    await expect(removeGithubRunnerOrg(runnerId, org, metrics)).rejects.toThrow();

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromOrg).toBeCalledWith({
      org: org,
      runner_id: runnerId,
    });
    expect(getOrgInstallation).toBeCalled();
  });
});

describe('getRunner', () => {
  const irrelevantRunner: GhRunners = [
    {
      id: 1,
      name: 'name',
      os: 'linux',
      status: 'busy',
      busy: true,
      labels: [],
    },
  ];

  describe('getRunnerRepo', () => {
    it('succeeds', async () => {
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: {
          listSelfHostedRunnersForRepo: '',
          getSelfHostedRunnerForRepo: jest.fn().mockResolvedValue({ data: irrelevantRunner }),
        },
        apps: { getRepoInstallation: getRepoInstallation },
        paginate: jest.fn().mockResolvedValue(irrelevantRunner),
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await getRunnerRepo(repo, '1234', metrics)).toEqual(irrelevantRunner);

      expect(mockedOctokit.actions.getSelfHostedRunnerForRepo).toBeCalledWith({
        ...repo,
        runner_id: '1234',
      });
    });

    it('fails && return undefined', async () => {
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: {
          listSelfHostedRunnersForRepo: '',
          getSelfHostedRunnerForRepo: jest.fn().mockImplementation(() => {
            throw Error('some error');
          }),
        },
        apps: { getRepoInstallation: getRepoInstallation },
        paginate: jest.fn().mockResolvedValue(irrelevantRunner),
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await getRunnerRepo({ owner: 'owner', repo: 'repo' }, '1234', metrics)).toEqual(undefined);
    });
  });

  describe('getRunnerOrg', () => {
    it('succeeds', async () => {
      const org = 'mockedOrg';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: {
          listSelfHostedRunnersForOrg: '',
          getSelfHostedRunnerForOrg: jest.fn().mockResolvedValue({ data: irrelevantRunner }),
        },
        apps: { getOrgInstallation: getOrgInstallation },
        paginate: jest.fn().mockResolvedValue(irrelevantRunner),
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await getRunnerOrg(org, '1234', metrics)).toEqual(irrelevantRunner);

      expect(mockedOctokit.actions.getSelfHostedRunnerForOrg).toBeCalledWith({
        org: org,
        runner_id: '1234',
      });
    });

    it('fails && return undefined', async () => {
      const org = 'mockedOrg';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        actions: {
          listSelfHostedRunnersForOrg: '',
          getSelfHostedRunnerForOrg: jest.fn().mockImplementation(() => {
            throw Error('some error');
          }),
        },
        apps: { getOrgInstallation: getOrgInstallation },
        paginate: jest.fn().mockResolvedValue(irrelevantRunner),
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await getRunnerOrg(org, '1234', metrics)).toEqual(undefined);
    });
  });
});

describe('getRunnerTypes', () => {
  const scaleConfigYaml = `
runner_types:
    linux.2xlarge:
      instance_type: c5.2xlarge
      os: linux
      max_available: 1
      disk_size: 150
      is_ephemeral: false`;

  it('gets the contents, twice', async () => {
    const repo = { owner: 'owner', repo: 'repo' };
    const token1 = 'token1';
    const token2 = 'token2';
    const repoId = 'mockReturnValueOnce1';
    const mockCreateGithubAuth = mocked(createGithubAuth);
    const mockCreateOctoClient = mocked(createOctoClient);
    const getRepoInstallation = jest.fn().mockResolvedValue({
      data: { id: repoId },
    });
    const mockedOctokit = {
      apps: { getRepoInstallation: getRepoInstallation },
      repos: {
        getContent: jest.fn().mockResolvedValue({
          data: { content: Buffer.from(scaleConfigYaml).toString('base64') },
          status: 200,
        }),
      },
    };

    mockCreateGithubAuth.mockResolvedValueOnce(token1);
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce(token2);
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    await resetGHRunnersCaches();
    expect(await getRunnerTypes(repo, metrics)).toEqual(
      new Map([
        [
          'linux.2xlarge',
          {
            runnerTypeName: 'linux.2xlarge',
            instance_type: 'c5.2xlarge',
            os: 'linux',
            max_available: 1,
            disk_size: 150,
            is_ephemeral: false,
          },
        ],
      ]),
    );
    expect(await getRunnerTypes(repo, metrics)).toEqual(
      new Map([
        [
          'linux.2xlarge',
          {
            runnerTypeName: 'linux.2xlarge',
            instance_type: 'c5.2xlarge',
            os: 'linux',
            max_available: 1,
            disk_size: 150,
            is_ephemeral: false,
          },
        ],
      ]),
    );

    expect(mockCreateGithubAuth).toBeCalledTimes(2);
    expect(mockCreateGithubAuth).toBeCalledWith(undefined, 'app', Config.Instance.ghesUrlApi, metrics);
    expect(mockCreateGithubAuth).toBeCalledWith(repoId, 'installation', Config.Instance.ghesUrlApi, metrics);

    expect(mockCreateOctoClient).toBeCalledTimes(2);
    expect(mockCreateOctoClient).toBeCalledWith(token1, Config.Instance.ghesUrlApi);
    expect(mockCreateOctoClient).toBeCalledWith(token2, Config.Instance.ghesUrlApi);

    expect(getRepoInstallation).toBeCalledTimes(1);
    expect(getRepoInstallation).toBeCalledWith({ ...repo });

    expect(mockedOctokit.repos.getContent).toBeCalledTimes(1);
    expect(mockedOctokit.repos.getContent).toBeCalledWith({
      ...repo,
      path: Config.Instance.scaleConfigRepoPath,
    });
  });

  it('return is not 200', async () => {
    const repo = { owner: 'owner', repo: 'repo' };
    const mockCreateGithubAuth = mocked(createGithubAuth);
    const mockCreateOctoClient = mocked(createOctoClient);
    const getRepoInstallation = jest.fn().mockResolvedValue({
      data: { id: 'mockReturnValueOnce1' },
    });
    const mockedOctokit = {
      apps: { getRepoInstallation: getRepoInstallation },
      repos: {
        getContent: jest.fn().mockResolvedValue({
          data: { content: Buffer.from(scaleConfigYaml).toString('base64') },
          status: 500,
        }),
      },
    };

    mockCreateGithubAuth.mockResolvedValueOnce('token1');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce('token2');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    await resetGHRunnersCaches();
    await expect(getRunnerTypes(repo, metrics)).rejects.toThrow(Error);
  });
});

describe('createRegistrationToken', () => {
  describe('createRegistrationTokenRepo', () => {
    it('gets twice, using cache', async () => {
      const testToken = 'TOKEN-AGDGADUWG113';
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        apps: { getRepoInstallation: getRepoInstallation },
        actions: {
          createRegistrationTokenForRepo: jest.fn().mockResolvedValueOnce({
            status: 201,
            data: { token: testToken },
          }),
        },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await createRegistrationTokenRepo(repo, metrics)).toEqual(testToken);
      expect(await createRegistrationTokenRepo(repo, metrics)).toEqual(testToken);
      expect(mockCreateGithubAuth).toBeCalledTimes(2);
      expect(mockCreateOctoClient).toBeCalledTimes(2);
      expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledWith(repo);
      expect(getRepoInstallation).toBeCalledTimes(1);
      expect(getRepoInstallation).toBeCalledWith(repo);
    });

    it('gets twice, using cache, by installationId', async () => {
      const testToken = 'TOKEN-AGDGADUWG113';
      const installationId = 123;
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn();
      const mockedOctokit = {
        apps: { getRepoInstallation: getRepoInstallation },
        actions: {
          createRegistrationTokenForRepo: jest.fn().mockResolvedValueOnce({
            status: 201,
            data: { token: testToken },
          }),
        },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await createRegistrationTokenRepo(repo, metrics, installationId)).toEqual(testToken);
      expect(await createRegistrationTokenRepo(repo, metrics, installationId)).toEqual(testToken);
      expect(mockCreateGithubAuth).toBeCalledTimes(1);
      expect(mockCreateOctoClient).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledWith(repo);
      expect(getRepoInstallation).not.toBeCalled();
    });

    it('fails to get, trow exception', async () => {
      const repo = { owner: 'owner', repo: 'repo' };
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getRepoInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        apps: { getRepoInstallation: getRepoInstallation },
        actions: {
          createRegistrationTokenForRepo: jest.fn().mockResolvedValueOnce({
            status: 201,
            data: {},
          }),
        },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      await expect(createRegistrationTokenRepo(repo, metrics)).rejects.toThrow(Error);
      expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledWith(repo);
    });
  });

  describe('createRegistrationTokenOrg', () => {
    it('gets twice, using cache', async () => {
      const testToken = 'TOKEN-AGDGADUWG113';
      const org = 'WG113';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        apps: { getOrgInstallation: getOrgInstallation },
        actions: {
          createRegistrationTokenForOrg: jest.fn().mockResolvedValueOnce({
            status: 201,
            data: { token: testToken },
          }),
        },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await createRegistrationTokenOrg(org, metrics)).toEqual(testToken);
      expect(await createRegistrationTokenOrg(org, metrics)).toEqual(testToken);
      expect(mockCreateGithubAuth).toBeCalledTimes(2);
      expect(mockCreateOctoClient).toBeCalledTimes(2);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledWith({ org: org });
      expect(getOrgInstallation).toBeCalledTimes(1);
      expect(getOrgInstallation).toBeCalledWith({ org: org });
    });

    it('gets twice, using cache, by installationId', async () => {
      const testToken = 'TOKEN-AGDGADUWG113';
      const installationId = 123;
      const org = 'WG113';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn();
      const mockedOctokit = {
        apps: { getOrgInstallation: getOrgInstallation },
        actions: {
          createRegistrationTokenForOrg: jest.fn().mockResolvedValueOnce({
            status: 201,
            data: { token: testToken },
          }),
        },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      expect(await createRegistrationTokenOrg(org, metrics, installationId)).toEqual(testToken);
      expect(await createRegistrationTokenOrg(org, metrics, installationId)).toEqual(testToken);
      expect(mockCreateGithubAuth).toBeCalledTimes(1);
      expect(mockCreateOctoClient).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledWith({ org: org });
      expect(getOrgInstallation).not.toBeCalled();
    });

    it('fails to get, trow exception', async () => {
      const org = 'WG113';
      const mockCreateGithubAuth = mocked(createGithubAuth);
      const mockCreateOctoClient = mocked(createOctoClient);
      const getOrgInstallation = jest.fn().mockResolvedValue({
        data: { id: 'mockReturnValueOnce1' },
      });
      const mockedOctokit = {
        apps: { getOrgInstallation: getOrgInstallation },
        actions: {
          createRegistrationTokenForOrg: jest.fn().mockResolvedValueOnce({
            status: 201,
            data: {},
          }),
        },
      };

      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

      await resetGHRunnersCaches();
      await expect(createRegistrationTokenOrg(org, metrics)).rejects.toThrow(Error);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledWith({ org: org });
    });
  });
});
