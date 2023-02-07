import { createRunner } from './runners';
import {
  createRegistrationTokenOrg,
  createRegistrationTokenRepo,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
} from './gh-runners';

import { Config } from './config';
import { getRepoIssuesWithLabel, GhIssues } from './gh-issues';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';
import { scaleUp } from './scale-up';
import * as MetricsModule from './metrics';

jest.mock('./runners');
jest.mock('./gh-runners');
jest.mock('./gh-issues');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
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

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion)).toEqual(
      `--url ${config.ghesUrlHost}/owner --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label  --runnergroup group_one`,
    );
    expect(mockedCreateRegistrationTokenForOrg).toBeCalledTimes(1);
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

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(1);
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

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(1);
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

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge,` +
        `extra-label `,
    );
    expect(mockedCreateRegistrationTokenForRepo).toBeCalledTimes(1);
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

  it('max runners reached, but new is ephemeral', async () => {
    const token = 'AGDGADUWG113';
    const config = {
      ...baseCfg,
      environment: 'config.environ',
      ghesUrlHost: 'https://github.com',
      minAvailableRunners: 1,
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const payload = {
      id: 10,
      eventType: 'event',
      repositoryName: 'repo',
      repositoryOwner: 'owner',
      installationId: 0,
    };
    const runnerType1 = {
      instance_type: 'instance_type',
      os: 'os',
      max_available: 1,
      disk_size: 113,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: true,
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
    mocked(createRegistrationTokenRepo).mockResolvedValue(token);
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

    expect(await mockedCreateRunner.mock.calls[0][0].runnerConfig(config.awsRegion)).toEqual(
      `--url ${config.ghesUrlHost}/owner/repo --token ${token} --labels AWS:${config.awsRegion},linux.2xlarge` +
        ` --ephemeral`,
    );
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
});
