import { mocked } from 'ts-jest/utils';
import { Octokit } from '@octokit/rest';
import { ActionRequestMessage, scaleUp } from './scale-up';
import { listRunners, createRunner, listGithubRunners, createGitHubClientForRunner } from './runners';
import * as ghAuth from './gh-auth';
import nock from 'nock';

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockImplementation(() => jest.fn().mockImplementation(() => ({ token: 'Blaat' }))),
}));
const mockOctokit = {
  checks: { get: jest.fn() },
  actions: {
    createRegistrationTokenForOrg: jest.fn(),
    createRegistrationTokenForRepo: jest.fn(),
  },
  apps: {
    getOrgInstallation: jest.fn(),
    getRepoInstallation: jest.fn(),
  },
};
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => mockOctokit),
}));

const LINUX_2XLARGE_LABEL = {
  id: 321,
  name: 'linux.2xlarge',
  type: 'read-only' as const,
};

function buildRunnerData(name: string, busy: boolean) {
  return {
    id: 123,
    name: name,
    busy: busy,
    os: 'os',
    status: 'status',
    labels: [LINUX_2XLARGE_LABEL],
  };
}

const DEFAULT_GH_RUNNERS = [
  buildRunnerData('i-idle-101', false),
  buildRunnerData('i-idle-102', false),
  buildRunnerData('i-running-103', true),
  buildRunnerData('i-idle-104', false),
  buildRunnerData('i-idle-105', false),
  buildRunnerData('i-idle-105', false),
  buildRunnerData('i-idle-106', false),
  buildRunnerData('i-idle-107', false),
  buildRunnerData('i-idle-108', false),
  buildRunnerData('i-idle-109', false),
  buildRunnerData('i-idle-110', false),
  buildRunnerData('i-idle-111', false),
];

const GITHUB_SCALE_CONFIG_BASE64 = Buffer.from(`
runner_types:
  linux.2xlarge:
    instance_type: c5.2xlarge
    os: linux
    max_available: 1000
    disk_size: 150
    is_ephemeral: false
`).toString('base64');

jest.mock('./runners', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ...jest.requireActual('./runners') as any,
  createRunner: jest.fn(),
  listRunners: jest.fn(),
  terminateRunner: jest.fn(),
  listGithubRunners: jest.fn(),
  createGitHubClientForRunner: jest.fn(async () => ({
    repos: {
      getContent: jest.fn(async () => ({
        data: {
          content: GITHUB_SCALE_CONFIG_BASE64,
        },
      })),
    },
  })),
}));

const TEST_DATA: ActionRequestMessage = {
  id: 1,
  eventType: 'check_run',
  repositoryName: 'hello-world',
  repositoryOwner: 'Codertocat',
  installationId: 2,
  runnerLabels: ["linux.2xlarge"]
};

const TEST_DATA_WITHOUT_INSTALL_ID: ActionRequestMessage = {
  id: 3,
  eventType: 'check_run',
  repositoryName: 'hello-world',
  repositoryOwner: 'Codertocat',
  installationId: 0,
  runnerLabels: ["linux.2xlarge"]
};

const cleanEnv = process.env;

beforeEach(() => {
  nock.disableNetConnect();
  jest.resetModules();
  jest.clearAllMocks();
  process.env = { ...cleanEnv };
  process.env.GITHUB_APP_KEY_BASE64 = 'TEST_CERTIFICATE_DATA';
  process.env.GITHUB_APP_ID = '1337';
  process.env.GITHUB_APP_CLIENT_ID = 'TEST_CLIENT_ID';
  process.env.GITHUB_APP_CLIENT_SECRET = 'TEST_CLIENT_SECRET';
  process.env.RUNNERS_MAXIMUM_COUNT = '3';
  process.env.ENVIRONMENT = 'unit-test-environment';

  mockOctokit.checks.get.mockImplementation(() => ({
    data: {
      status: 'queued',
    },
  }));
  const mockTokenReturnValue = {
    data: {
      token: '1234abcd',
    },
  };
  const mockInstallationIdReturnValueOrgs = {
    data: {
      id: TEST_DATA.installationId,
    },
  };
  const mockInstallationIdReturnValueRepos = {
    data: {
      id: TEST_DATA.installationId,
    },
  };

  mockOctokit.actions.createRegistrationTokenForOrg.mockImplementation(() => mockTokenReturnValue);
  mockOctokit.actions.createRegistrationTokenForRepo.mockImplementation(() => mockTokenReturnValue);
  mockOctokit.apps.getOrgInstallation.mockImplementation(() => mockInstallationIdReturnValueOrgs);
  mockOctokit.apps.getRepoInstallation.mockImplementation(() => mockInstallationIdReturnValueRepos);
  const mockListRunners = mocked(listRunners);
  mockListRunners.mockImplementation(async () => [
    {
      instanceId: 'i-1234',
      launchTime: new Date(),
      repo: `${TEST_DATA.repositoryOwner}/${TEST_DATA.repositoryName}`,
      org: TEST_DATA.repositoryOwner,
      runnerType: 'linuxCpu',
      ghRunnerId: '123',
    },
  ]);
});

describe('scaleUp with GHES', () => {
  beforeEach(() => {
    process.env.GHES_URL = 'https://github.enterprise.something';
  });

  it('ignores non-sqs events', async () => {
    expect.assertions(1);
    expect(scaleUp('aws:s3', TEST_DATA)).rejects.toEqual(Error('Cannot handle non-SQS events!'));
  });

  describe('on repo level', () => {
    beforeEach(() => {
      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return DEFAULT_GH_RUNNERS;
      });
    });

    it('gets the current repo level runners', async () => {
      await scaleUp('aws:sqs', TEST_DATA);
      expect(listRunners).toBeCalledWith({
        environment: 'unit-test-environment',
        repoName: `${TEST_DATA.repositoryOwner}/${TEST_DATA.repositoryName}`,
      });
    });

    it('does not create a token when maximum runners has been reached', async () => {
      const mockCreateGitHubClientForRunner = mocked(createGitHubClientForRunner);
      mockCreateGitHubClientForRunner.mockReturnValue(Promise.resolve({
        repos: {
          getContent: jest.fn(async () => ({
            data: {
              content: Buffer.from(`
runner_types:
  linux.2xlarge:
    instance_type: c5.2xlarge
    os: linux
    max_available: 1
    disk_size: 150
    is_ephemeral: false
              `).toString('base64'),
            },
          })),
        },
      } as unknown as Octokit));
      await scaleUp('aws:sqs', TEST_DATA);
      expect(mockOctokit.actions.createRegistrationTokenForRepo).not.toBeCalled();
    });

    it('creates a token when maximum runners has not been reached', async () => {
      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return [
          buildRunnerData('i-running-101', true),
          buildRunnerData('i-running-102', true),
          buildRunnerData('i-running-103', true),
          buildRunnerData('i-running-104', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-106', true),
          buildRunnerData('i-running-107', true),
          buildRunnerData('i-running-108', true),
          buildRunnerData('i-running-109', true),
          buildRunnerData('i-running-110', true),
          buildRunnerData('i-running-111', true),
        ];
      });
      await scaleUp('aws:sqs', TEST_DATA);
      expect(mockOctokit.actions.createRegistrationTokenForRepo).toBeCalledWith({
        owner: TEST_DATA.repositoryOwner,
        repo: TEST_DATA.repositoryName,
      });
    });

    it('does not retrieve installation id if already set', async () => {
      const spy = jest.spyOn(ghAuth, 'createGithubAuth');
      await scaleUp('aws:sqs', TEST_DATA);
      expect(mockOctokit.apps.getRepoInstallation).not.toBeCalled();
      expect(spy).toBeCalledWith(
        TEST_DATA.installationId,
        'installation',
        '',
      );
    });

    it('retrieves installation id if not set', async () => {
      const spy = jest.spyOn(ghAuth, 'createGithubAuth');
      await scaleUp('aws:sqs', TEST_DATA_WITHOUT_INSTALL_ID);
      expect(mockOctokit.apps.getOrgInstallation).not.toBeCalled();
      expect(spy).toHaveBeenNthCalledWith(1, undefined, 'app', '');
      expect(spy).toHaveBeenNthCalledWith(
        2,
        TEST_DATA.installationId,
        'installation',
        '',
      );
    });

    it('creates a runner with correct config and labels', async () => {
      process.env.RUNNER_EXTRA_LABELS = 'label1,label2';

      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return [
          buildRunnerData('i-running-101', true),
          buildRunnerData('i-running-102', true),
          buildRunnerData('i-running-103', true),
          buildRunnerData('i-running-104', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-106', true),
          buildRunnerData('i-running-107', true),
          buildRunnerData('i-running-108', true),
          buildRunnerData('i-running-109', true),
          buildRunnerData('i-running-110', true),
          buildRunnerData('i-running-111', true),
        ];
      });

      await scaleUp('aws:sqs', TEST_DATA);

      expect(createRunner).toBeCalledWith({
        environment: 'unit-test-environment',
        runnerConfig:
          "--url https://github.com/Codertocat/hello-world " +
          "--token 1234abcd --labels linux.2xlarge,label1,label2 ",
        runnerType: {
          disk_size: 150,
          instance_type: "c5.2xlarge",
          is_ephemeral: false,
          max_available: 1000,
          os: "linux",
          runnerTypeName: "linux.2xlarge",
        },
        orgName: undefined,
        repoName: `${TEST_DATA.repositoryOwner}/${TEST_DATA.repositoryName}`,
      });
    });

    it('creates a runner and ensure the group argument is ignored', async () => {
      process.env.RUNNER_EXTRA_LABELS = 'label1,label2';
      process.env.RUNNER_GROUP_NAME = 'TEST_GROUP_IGNORED';

      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return [
          buildRunnerData('i-running-101', true),
          buildRunnerData('i-running-102', true),
          buildRunnerData('i-running-103', true),
          buildRunnerData('i-running-104', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-106', true),
          buildRunnerData('i-running-107', true),
          buildRunnerData('i-running-108', true),
          buildRunnerData('i-running-109', true),
          buildRunnerData('i-running-110', true),
          buildRunnerData('i-running-111', true),
        ];
      });

      await scaleUp('aws:sqs', TEST_DATA);
      expect(createRunner).toBeCalledWith({
        environment: 'unit-test-environment',
        runnerConfig:
          "--url https://github.com/Codertocat/hello-world " +
          "--token 1234abcd --labels linux.2xlarge,label1,label2 ",
        runnerType: {
          disk_size: 150,
          instance_type: "c5.2xlarge",
          is_ephemeral: false,
          max_available: 1000,
          os: "linux",
          runnerTypeName: "linux.2xlarge",
        },
        orgName: undefined,
        repoName: `${TEST_DATA.repositoryOwner}/${TEST_DATA.repositoryName}`,
      });
    });
  });
});

describe('scaleUp with public GH', () => {
  it('ignores non-sqs events', async () => {
    expect.assertions(1);
    expect(scaleUp('aws:s3', TEST_DATA)).rejects.toEqual(Error('Cannot handle non-SQS events!'));
  });

  it('does not retrieve installation id if already set', async () => {
    const spy = jest.spyOn(ghAuth, 'createGithubAuth');
    await scaleUp('aws:sqs', TEST_DATA);
    expect(mockOctokit.apps.getOrgInstallation).not.toBeCalled();
    expect(mockOctokit.apps.getRepoInstallation).not.toBeCalled();
    expect(spy).toBeCalledWith(TEST_DATA.installationId, 'installation', '');
  });

  it('retrieves installation id if not set', async () => {
    const spy = jest.spyOn(ghAuth, 'createGithubAuth');
    await scaleUp('aws:sqs', TEST_DATA_WITHOUT_INSTALL_ID);
    expect(mockOctokit.apps.getRepoInstallation).toBeCalled();
    expect(spy).toHaveBeenNthCalledWith(1, undefined, 'app', '');
    expect(spy).toHaveBeenNthCalledWith(2, TEST_DATA.installationId, 'installation', '');
  });

  describe('on repo level', () => {
    beforeEach(() => {
      process.env.ENABLE_ORGANIZATION_RUNNERS = 'false';

      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return DEFAULT_GH_RUNNERS;
      });
    });

    it('gets the current repo level runners', async () => {
      await scaleUp('aws:sqs', TEST_DATA);
      expect(listRunners).toBeCalledWith({
        environment: 'unit-test-environment',
        repoName: `${TEST_DATA.repositoryOwner}/${TEST_DATA.repositoryName}`,
      });
    });

    it('does not create a token when maximum runners has been reached', async () => {
      const mockCreateGitHubClientForRunner = mocked(createGitHubClientForRunner);
      mockCreateGitHubClientForRunner.mockReturnValue(Promise.resolve({
        repos: {
          getContent: jest.fn(async () => ({
            data: {
              content: Buffer.from(`
runner_types:
  linux.2xlarge:
    instance_type: c5.2xlarge
    os: linux
    max_available: 1
    disk_size: 150
    is_ephemeral: false
              `).toString('base64'),
            },
          })),
        },
      } as unknown as Octokit));

      await scaleUp('aws:sqs', TEST_DATA);

      expect(mockOctokit.actions.createRegistrationTokenForRepo).not.toBeCalled();
    });

    it('creates a token when maximum runners has not been reached', async () => {
      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return [
          buildRunnerData('i-running-101', true),
          buildRunnerData('i-running-102', true),
          buildRunnerData('i-running-103', true),
          buildRunnerData('i-running-104', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-106', true),
          buildRunnerData('i-running-107', true),
          buildRunnerData('i-running-108', true),
          buildRunnerData('i-running-109', true),
          buildRunnerData('i-running-110', true),
          buildRunnerData('i-running-111', true),
        ];
      });

      await scaleUp('aws:sqs', TEST_DATA);

      expect(mockOctokit.actions.createRegistrationTokenForRepo).toBeCalledWith({
        owner: TEST_DATA.repositoryOwner,
        repo: TEST_DATA.repositoryName,
      });
    });

    it('does not retrieve installation id if already set', async () => {
      const spy = jest.spyOn(ghAuth, 'createGithubAuth');
      await scaleUp('aws:sqs', TEST_DATA);
      expect(mockOctokit.apps.getOrgInstallation).not.toBeCalled();
      expect(mockOctokit.apps.getRepoInstallation).not.toBeCalled();
      expect(spy).toBeCalledWith(TEST_DATA.installationId, 'installation', '');
    });

    it('retrieves installation id if not set', async () => {
      const spy = jest.spyOn(ghAuth, 'createGithubAuth');
      await scaleUp('aws:sqs', TEST_DATA_WITHOUT_INSTALL_ID);
      expect(mockOctokit.apps.getOrgInstallation).not.toBeCalled();
      expect(spy).toHaveBeenNthCalledWith(1, undefined, 'app', '');
      expect(spy).toHaveBeenNthCalledWith(2, TEST_DATA.installationId, 'installation', '');
    });

    it('creates a runner with correct config and labels', async () => {
      process.env.RUNNER_EXTRA_LABELS = 'label1,label2';

      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return [
          buildRunnerData('i-running-101', true),
          buildRunnerData('i-running-102', true),
          buildRunnerData('i-running-103', true),
          buildRunnerData('i-running-104', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-106', true),
          buildRunnerData('i-running-107', true),
          buildRunnerData('i-running-108', true),
          buildRunnerData('i-running-109', true),
          buildRunnerData('i-running-110', true),
          buildRunnerData('i-running-111', true),
        ];
      });

      await scaleUp('aws:sqs', TEST_DATA);

      expect(createRunner).toBeCalledWith({
        environment: 'unit-test-environment',
        runnerConfig:
          "--url https://github.com/Codertocat/hello-world " +
          "--token 1234abcd --labels linux.2xlarge,label1,label2 ",
        runnerType: {
          disk_size: 150,
          instance_type: "c5.2xlarge",
          is_ephemeral: false,
          max_available: 1000,
          os: "linux",
          runnerTypeName: "linux.2xlarge",
        },
        orgName: undefined,
        repoName: `${TEST_DATA.repositoryOwner}/${TEST_DATA.repositoryName}`,
      });
    });

    it('creates a runner and ensure the group argument is ignored', async () => {
      process.env.RUNNER_EXTRA_LABELS = 'label1,label2';
      process.env.RUNNER_GROUP_NAME = 'TEST_GROUP_IGNORED';

      const mockListGithubRunners = mocked(listGithubRunners);
      mockListGithubRunners.mockImplementation(async () => {
        return [
          buildRunnerData('i-running-101', true),
          buildRunnerData('i-running-102', true),
          buildRunnerData('i-running-103', true),
          buildRunnerData('i-running-104', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-105', true),
          buildRunnerData('i-running-106', true),
          buildRunnerData('i-running-107', true),
          buildRunnerData('i-running-108', true),
          buildRunnerData('i-running-109', true),
          buildRunnerData('i-running-110', true),
          buildRunnerData('i-running-111', true),
        ];
      });

      await scaleUp('aws:sqs', TEST_DATA);

      expect(createRunner).toBeCalledWith({
        environment: 'unit-test-environment',
        runnerConfig:
          "--url https://github.com/Codertocat/hello-world " +
          "--token 1234abcd --labels linux.2xlarge,label1,label2 ",
        runnerType: {
          disk_size: 150,
          instance_type: "c5.2xlarge",
          is_ephemeral: false,
          max_available: 1000,
          os: "linux",
          runnerTypeName: "linux.2xlarge",
        },
        orgName: undefined,
        repoName: `${TEST_DATA.repositoryOwner}/${TEST_DATA.repositoryName}`,
      });
    });
  });
});
