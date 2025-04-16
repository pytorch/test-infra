import { createRunner, tryReuseRunner } from './runners';
import {
  createRegistrationTokenOrg,
  createRegistrationTokenRepo,
  getGitHubRateLimit,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
} from './gh-runners';

import { Config } from './config';
import { getRepoIssuesWithLabel, GhIssues } from './gh-issues';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';
import { scaleUp, _calculateScaleUpAmount } from './scale-up';
import * as MetricsModule from './metrics';
import { getJoinedStressTestExperiment } from './cache';
import { sleep } from './utils';

jest.mock('./cache');
jest.mock('./gh-issues');
jest.mock('./gh-runners');
jest.mock('./runners');
jest.mock('./utils', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./utils') as any),
  sleep: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();

  mocked(getGitHubRateLimit).mockResolvedValue({ limit: 5000, remaining: 4999, used: 1 });
  mocked(sleep).mockClear().mockResolvedValue(undefined);
});

const baseCfg = {
  awsRegion: 'us-east-1',
  cantHaveIssuesLabels: [],
  mustHaveIssuesLabels: [],
  lambdaTimeout: 600,
} as unknown as Config;

const metrics = new MetricsModule.ScaleUpMetrics();

describe('scaleUp', () => {
  beforeEach(() => {
    jest.spyOn(MetricsModule, 'ScaleUpMetrics').mockReturnValue(metrics);
    jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {
      return;
    });
    mocked(getJoinedStressTestExperiment).mockClear().mockResolvedValue(false);
  });
  it('does not accept sources that are not aws:sqs', async () => {
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
      runnerLabels: [],
    };
    await expect(scaleUp('other', payload, metrics)).rejects.toThrow('Cannot handle non-SQS events!');
  });

  it('provides runnerLabels that aren`t present on runnerTypes', async () => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
      runnerLabels: ['label1', 'label2'],
    };
    const mockedGetRunnerTypes = mocked(getRunnerTypes).mockResolvedValue(
      new Map([
        [
          'label1-nomatch',
          {
            instance_type: 'instance_type',
            os: 'os',
            max_available: 33,
            disk_size: 113,
            runnerTypeName: 'runnerTypeName',
            is_ephemeral: false,
          },
        ],
      ]),
    );
    const mockedListGithubRunners = mocked(listGithubRunnersRepo);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedGetRunnerTypes).toBeCalledTimes(1);
    expect(mockedGetRunnerTypes).toBeCalledWith({ repo: 'repo', owner: 'owner' }, metrics);
    expect(mockedListGithubRunners).not.toBeCalled();
  });

  it('uses the scaleConfigRepo when provided', async () => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(
      () =>
        ({
          ...baseCfg,
          enableOrganizationRunners: false,
          scaleConfigRepo: 'scale-config-repo',
        } as unknown as Config),
    );
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
      runnerLabels: ['label1', 'label2'],
    };
    const mockedGetRunnerTypes = mocked(getRunnerTypes).mockResolvedValue(
      new Map([
        [
          'label1-nomatch',
          {
            instance_type: 'instance_type',
            os: 'os',
            max_available: 33,
            disk_size: 113,
            runnerTypeName: 'runnerTypeName',
            is_ephemeral: false,
          },
        ],
      ]),
    );
    const mockedListGithubRunners = mocked(listGithubRunnersRepo);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedGetRunnerTypes).toBeCalledTimes(1);
    expect(mockedGetRunnerTypes).toBeCalledWith({ repo: 'scale-config-repo', owner: 'owner' }, metrics);
    expect(mockedListGithubRunners).not.toBeCalled();
  });

  it('have available runners', async () => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(
      () =>
        ({
          ...baseCfg,
          minAvailableRunners: 1,
        } as unknown as Config),
    );
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const mockedGetRunnerTypes = mocked(getRunnerTypes).mockResolvedValue(
      new Map([
        [
          'linux.2xlarge',
          {
            instance_type: 'instance_type',
            os: 'os',
            max_available: 33,
            disk_size: 113,
            runnerTypeName: 'linux.2xlarge',
            is_ephemeral: false,
          },
        ],
        [
          'linux.large',
          {
            instance_type: 'instance_type',
            os: 'os',
            max_available: 33,
            disk_size: 113,
            runnerTypeName: 'linux.large',
            is_ephemeral: false,
          },
        ],
      ]),
    );
    const mockedListGithubRunners = mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 333,
        name: 'name-01',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.large',
            type: 'read-only',
          },
        ],
      },
      {
        id: 3333,
        name: 'name-02',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.large',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedGetRunnerTypes).toBeCalledTimes(1);
    expect(mockedGetRunnerTypes).toBeCalledWith(repo, metrics);
    expect(mockedListGithubRunners).toBeCalledTimes(2);
    expect(mockedListGithubRunners).toBeCalledWith(repo, metrics);
    expect(mockedCreateRegistrationTokenForRepo).not.toBeCalled();
  });

  it('don`t have sufficient runners for organization', async () => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
      runnerGroupName: 'group_one',
      runnersExtraLabels: 'extra-label',
      enableOrganizationRunners: 'yes',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 33,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForOrg = mocked(createRegistrationTokenOrg).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedListGithubRunnersOrg).toBeCalledWith(repo.owner, metrics);
    expect(mockedCreateRunner).toBeCalledTimes(1);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        runnerConfig: expect.any(Function),
        orgName: repo.owner,
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label  --runnergroup group_one`,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `experimental.ami,extra-label --ephemeral --runnergroup group_one`,
    );
    expect(mockedCreateRegistrationTokenForOrg).toBeCalledTimes(2);
    expect(mockedCreateRegistrationTokenForOrg).toBeCalledWith(repo.owner, metrics, 2);
  });

  it('don`t have sufficient runners', async (): Promise<void> => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 33,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).toBeCalledTimes(1);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        runnerConfig: expect.any(Function),
        repoName: 'owner/repo',
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `experimental.ami,extra-label --ephemeral`,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(2);
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledWith(repo, metrics, 2);
  });

  it('don`t have sufficient runners, max_available is negative', async (): Promise<void> => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: -1,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).toBeCalledTimes(1);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        runnerConfig: expect.any(Function),
        repoName: 'owner/repo',
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `experimental.ami,extra-label --ephemeral`,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(2);
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledWith(repo, metrics, 2);
  });

  it('don`t have sufficient runners, max_available is not set', async (): Promise<void> => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).toBeCalledTimes(1);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        runnerConfig: expect.any(Function),
        repoName: 'owner/repo',
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `experimental.ami,extra-label --ephemeral`,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(2);
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledWith(repo, metrics, 2);
  });

  it('don`t have sufficient runners, max_available is undefined', async (): Promise<void> => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
      max_available: undefined,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'live',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).toBeCalledTimes(1);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        runnerConfig: expect.any(Function),
        repoName: 'owner/repo',
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `experimental.ami,extra-label --ephemeral`,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(2);
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledWith(repo, metrics, 2);
  });

  it('runners are offline', async () => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 1,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 0,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 33,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'offline',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'offline',
        busy: false,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).toBeCalledTimes(1);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        runnerConfig: expect.any(Function),
        repoName: 'owner/repo',
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `experimental.ami,extra-label --ephemeral`,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(2);
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledWith(repo, metrics, 0);
  });

  it('runners are busy', async () => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 1,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const repo = { repo: 'repo', owner: 'owner' };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: undefined,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 33,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'busy',
        busy: true,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
      {
        id: 33,
        name: 'name-02',
        os: 'linux',
        status: 'busy',
        busy: true,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).toBeCalledTimes(1);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        runnerConfig: expect.any(Function),
        repoName: 'owner/repo',
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `experimental.ami,extra-label --ephemeral`,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(2);
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledWith(repo, metrics, undefined);
  });

  it('max runners reached', async () => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 1,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 1,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'busy',
        busy: true,
        labels: [
          {
            id: 113,
            name: 'linux.2xlarge',
            type: 'read-only',
          },
        ],
      },
    ]);
    const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRegistrationTokenForRepo).not.toBeCalled();
  });

  it('max runners reached, but new is ephemeral, and there is none to reuse', async () => {
    const token = 'AGDGADUWG113';
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 1,
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 1,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: true,
    };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 0,
      runnerLabels: [runnerType1.runnerTypeName],
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([[runnerType1.runnerTypeName, runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'busy',
        busy: true,
        labels: [
          {
            id: 113,
            name: runnerType1.runnerTypeName,
            type: 'read-only',
          },
        ],
      },
    ]);
    mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    mocked(tryReuseRunner).mockRejectedValue(new Error('No runners available'));
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).toBeCalledWith(
      {
        environment: config.environment,
        // eslint-disable-next-line max-len
        runnerConfig: expect.any(Function),
        repoName: 'owner/repo',
        runnerType: runnerType1,
      },
      metrics,
    );

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},` +
        `${runnerType1.runnerTypeName} --ephemeral`,
    );
    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},` +
        `${runnerType1.runnerTypeName},experimental.ami --ephemeral`,
    );
  });

  it('max runners reached, but new is ephemeral, and there is one to reuse', async () => {
    const token = 'AGDGADUWG113';
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 1,
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 1,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: true,
    };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 0,
      runnerLabels: [runnerType1.runnerTypeName],
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([[runnerType1.runnerTypeName, runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([
      {
        id: 3,
        name: 'name-01',
        os: 'linux',
        status: 'busy',
        busy: true,
        labels: [
          {
            id: 113,
            name: runnerType1.runnerTypeName,
            type: 'read-only',
          },
        ],
      },
    ]);
    mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    mocked(tryReuseRunner).mockResolvedValue({
      awsRegion: 'us-east-1',
      az: 'us-east-1a',
      ephemeralRunnerFinished: 113,
      ghRunnerId: '1234',
      instanceId: 'i-0113',
      launchTime: new Date(),
      repo: 'jeanschmidt/regularizationTheory',
    });
    const mockedCreateRunner = mocked(createRunner);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedCreateRunner).not.toBeCalled();
  });

  it('dont have mustHaveIssuesLabels', async () => {
    const config = {
      ...baseCfg,
      mustHaveIssuesLabels: ['label_01', 'label_02'],
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
    };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const repo = {
      repo: payload.repositoryName,
      owner: payload.repositoryOwner,
    };

    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const mockedGetRunnerTypes = mocked(getRunnerTypes);
    const mockedGetRepoIssuesWithLabel = mocked(getRepoIssuesWithLabel);
    mockedGetRepoIssuesWithLabel.mockResolvedValueOnce([{ something: 1 }] as unknown as GhIssues);
    mockedGetRepoIssuesWithLabel.mockResolvedValueOnce([]);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedGetRunnerTypes).not.toBeCalled();
    expect(mockedGetRepoIssuesWithLabel).toBeCalledTimes(2);
    expect(mockedGetRepoIssuesWithLabel).toBeCalledWith(repo, config.mustHaveIssuesLabels[0], metrics);
    expect(mockedGetRepoIssuesWithLabel).toBeCalledWith(repo, config.mustHaveIssuesLabels[1], metrics);
  });

  it('have the issues that cant have', async () => {
    const config = {
      ...baseCfg,
      cantHaveIssuesLabels: ['label_01', 'label_02'],
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
    };
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const repo = {
      repo: payload.repositoryName,
      owner: payload.repositoryOwner,
    };

    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const mockedGetRunnerTypes = mocked(getRunnerTypes);
    const mockedGetRepoIssuesWithLabel = mocked(getRepoIssuesWithLabel);
    mockedGetRepoIssuesWithLabel.mockResolvedValueOnce([]);
    mockedGetRepoIssuesWithLabel.mockResolvedValueOnce([{ something: 1 }] as unknown as GhIssues);

    await scaleUp('aws:sqs', payload, metrics);
    expect(mockedGetRunnerTypes).not.toBeCalled();
    expect(mockedGetRepoIssuesWithLabel).toBeCalledTimes(2);
    expect(mockedGetRepoIssuesWithLabel).toBeCalledWith(repo, config.cantHaveIssuesLabels[0], metrics);
    expect(mockedGetRepoIssuesWithLabel).toBeCalledWith(repo, config.cantHaveIssuesLabels[1], metrics);
  });

  it('delays with sleep when stresstest_ghapislow is set', async () => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 10,
      runnerGroupName: 'group_one',
      runnersExtraLabels: 'extra-label',
      enableOrganizationRunners: 'yes',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 2,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 33,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(createRegistrationTokenOrg).mockResolvedValue(token);
    const mockedCreateRunner = mocked(createRunner);

    mocked(getJoinedStressTestExperiment)
      .mockClear()
      /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
      .mockImplementation(async (experimentKey: string, runnerName: string) => {
        if (experimentKey === 'stresstest_ghapislow') {
          return true;
        }
        return false;
      });

    await scaleUp('aws:sqs', payload, metrics);

    expect(mockedCreateRunner).toBeCalledTimes(1);

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion, false)).toEqual(
      `--url ${config.ghesUrlHost}/owner --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label  --runnergroup group_one`,
    );

    expect(sleep).toHaveBeenCalledWith(60 * 1000);
    expect(getJoinedStressTestExperiment).toBeCalledWith('stresstest_ignorereq', 'linux.2xlarge');
    expect(getJoinedStressTestExperiment).toBeCalledWith('stresstest_ghapislow', 'linux.2xlarge');
  });

  it('ignore requests when stresstest_ignorereq is triggered', async () => {
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 1,
      runnersExtraLabels: 'extra-label',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 0,
    };
    const token = 'AGDGADUWG113';
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 33,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: false,
    };

    mocked(getRunnerTypes).mockResolvedValue(new Map([['linux.2xlarge', runnerType1]]));
    mocked(listGithubRunnersRepo).mockResolvedValue([]);
    mocked(createRegistrationTokenRepo).mockResolvedValue(token);
    // Make Math.random return a small value to trigger the stresstest_ignorereq condition
    jest.spyOn(global.Math, 'random').mockReturnValue(0.01);
    mocked(getJoinedStressTestExperiment).mockClear().mockResolvedValue(true);

    await scaleUp('aws:sqs', payload, metrics);

    expect(getJoinedStressTestExperiment).toBeCalledWith('stresstest_ignorereq', 'linux.2xlarge');
    expect(tryReuseRunner).not.toBeCalled();
    expect(createRunner).not.toBeCalled();
    expect(sleep).not.toBeCalled();
  });
});

describe('_calculateScaleUpAmount', () => {
  describe('When we are sufficently below the max scale up limit', () => {
    const maxScaleUp = Number.MAX_SAFE_INTEGER;

    it('When avail runners are high enough to handle request and stay above min, does not scale up', () => {
      const requestedCount = 4;
      const availableCount = 7;
      const minRunners = 2;

      for (const isEphemeral of [false, true]) {
        const scaleUpAmount = _calculateScaleUpAmount(
          requestedCount,
          isEphemeral,
          minRunners,
          maxScaleUp,
          availableCount,
        );

        expect(scaleUpAmount).toBe(0);
      }
    });

    it('No runners are available and below min, scales up', () => {
      const requestedCount = 1;
      const availableCount = 2;
      const minRunners = 10;
      const isEphemeral = false;

      const scaleUpAmount = _calculateScaleUpAmount(
        requestedCount,
        isEphemeral,
        minRunners,
        maxScaleUp,
        availableCount,
      );

      expect(scaleUpAmount).toBe(1);
    });

    it('When avail runners are high enough to handle request but will dip below min, scale ups partway to min', () => {
      const requestedCount = 4;
      const availableCount = 5;
      const minRunners = 4;

      for (const isEphemeral of [false, true]) {
        const scaleUpAmount = _calculateScaleUpAmount(
          requestedCount,
          isEphemeral,
          minRunners,
          maxScaleUp,
          availableCount,
        );

        // We were above min runners before, and we should scale up enough to not dip below min runners
        expect(scaleUpAmount).toEqual(3);
      }
    });

    it(
      'When avail runners are insuffiicent to handle request, ' +
        'provisions enough to handle request and also scale up partway to min',
      () => {
        const requestedCount = 6;
        const availableCount = 5;
        const minRunners = 4;

        for (const isEphemeral of [false, true]) {
          const scaleUpAmount = _calculateScaleUpAmount(
            requestedCount,
            isEphemeral,
            minRunners,
            maxScaleUp,
            availableCount,
          );

          const reqRemainingAfterUsingAvailableRuners = requestedCount - availableCount;

          // Not being exactly prescriptive with a value in this test so that we can tweak the results later without
          // needing to update the test.
          expect(scaleUpAmount).toBeGreaterThan(reqRemainingAfterUsingAvailableRuners); // Ensure we get extra instances
          expect(scaleUpAmount).toBeLessThanOrEqual(minRunners + reqRemainingAfterUsingAvailableRuners);
        }
      },
    );
  });

  describe('When we are near the max scale up limit', () => {
    it('When there is no additional capacity to scale up, does not scale up', () => {
      const requestedCount = 4;
      const availableCount = 2;
      const minRunners = 2;
      const maxScaleUp = 0;

      for (const isEphemeral of [false, true]) {
        const scaleUpAmount = _calculateScaleUpAmount(
          requestedCount,
          isEphemeral,
          minRunners,
          maxScaleUp,
          availableCount,
        );

        expect(scaleUpAmount).toBe(0);
      }
    });

    it(
      'When avail runners are high enough to handle request but will dip below min, ' +
        'Scale ups partway to min while staying below the max limit',
      () => {
        const requestedCount = 4;
        const availableCount = 2;
        const minRunners = 10;
        const maxScaleUp = 3;

        for (const isEphemeral of [false, true]) {
          const scaleUpAmount = _calculateScaleUpAmount(
            requestedCount,
            isEphemeral,
            minRunners,
            maxScaleUp,
            availableCount,
          );

          // Not being exactly prescriptive with all values in this test so that we can tweak the results later without
          // needing to update the test.
          expect(scaleUpAmount).toBeGreaterThan(requestedCount - availableCount); // Ensure we're get extra instances
          expect(scaleUpAmount).toBeLessThanOrEqual(minRunners);
          expect(scaleUpAmount).toBeLessThanOrEqual(maxScaleUp);
        }
      },
    );

    it(
      'When avail runners are insuffiicent to handle request, ' +
        'provisions enough to handle request from what is available',
      () => {
        const requestedCount = 6;
        const availableCount = 2;
        const minRunners = 4;
        const maxScaleUp = 3;

        for (const isEphemeral of [false, true]) {
          const scaleUpAmount = _calculateScaleUpAmount(
            requestedCount,
            isEphemeral,
            minRunners,
            maxScaleUp,
            availableCount,
          );

          expect(scaleUpAmount).toEqual(maxScaleUp);
        }
      },
    );
  });
});
