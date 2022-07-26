import {
  GhRunners,
  RunnerInfo,
  RunnerInputParameters,
  createGitHubClientForRunner,
  createRegistrationTokenForRepo,
  createRunner,
  getRepo,
  getRunner,
  getRunnerTypes,
  listGithubRunners,
  listRunners,
  removeGithubRunner,
  resetRunnersCaches,
  terminateRunner,
} from './runners';
import { createGithubAuth, createOctoClient } from './gh-auth';

import { Authentication } from '@octokit/auth-app/dist-types/types';
import { Config } from './config';
import { Octokit } from '@octokit/rest';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';

const mockEC2 = {
  describeInstances: jest.fn(),
  runInstances: jest.fn(),
  terminateInstances: jest.fn().mockReturnValue({ promise: jest.fn() }),
};
const mockSSM = { putParameter: jest.fn() };
jest.mock('aws-sdk', () => ({
  EC2: jest.fn().mockImplementation(() => mockEC2),
  SSM: jest.fn().mockImplementation(() => mockSSM),
}));

jest.mock('./gh-auth');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  nock.disableNetConnect();
});

function createExpectedRunInstancesLinux(runnerParameters: RunnerInputParameters, subnetId: number) {
  return {
    MaxCount: 1,
    MinCount: 1,
    LaunchTemplate: {
      LaunchTemplateName: Config.Instance.launchTemplateNameLinux,
      Version: Config.Instance.launchTemplateVersionLinux,
    },
    InstanceType: runnerParameters.runnerType.instance_type,
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/xvda',
        Ebs: {
          VolumeSize: runnerParameters.runnerType.disk_size,
          VolumeType: 'gp3',
          Encrypted: true,
          DeleteOnTermination: true,
        },
      },
    ],
    NetworkInterfaces: [
      {
        AssociatePublicIpAddress: true,
        SubnetId: Config.Instance.shuffledSubnetIds[subnetId],
        Groups: Config.Instance.securityGroupIds,
        DeviceIndex: 0,
      },
    ],
    TagSpecifications: [
      {
        ResourceType: 'instance',
        Tags: [
          { Key: 'Application', Value: 'github-action-runner' },
          {
            Key: 'Repo',
            Value: runnerParameters.repoName,
          },
          { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName },
        ],
      },
    ],
  };
}

describe('list instances', () => {
  const mockDescribeInstances = { promise: jest.fn() };
  beforeEach(() => {
    mockEC2.describeInstances.mockImplementation(() => mockDescribeInstances);
    const mockRunningInstances: AWS.EC2.DescribeInstancesResult = {
      Reservations: [
        {
          Instances: [
            {
              LaunchTime: new Date('2020-10-10T14:48:00.000+09:00'),
              InstanceId: 'i-1234',
              Tags: [
                { Key: 'Repo', Value: 'CoderToCat/hello-world' },
                { Key: 'Org', Value: 'CoderToCat' },
                { Key: 'Application', Value: 'github-action-runner' },
              ],
            },
            {
              LaunchTime: new Date('2020-10-11T14:48:00.000+09:00'),
              InstanceId: 'i-5678',
              Tags: [
                { Key: 'Repo', Value: 'SomeAwesomeCoder/some-amazing-library' },
                { Key: 'Org', Value: 'SomeAwesomeCoder' },
                { Key: 'Application', Value: 'github-action-runner' },
              ],
            },
          ],
        },
      ],
    };
    mockDescribeInstances.promise.mockReturnValue(mockRunningInstances);
  });

  it('returns a list of instances', async () => {
    const resp = await listRunners();
    expect(resp.length).toBe(2);
    expect(resp).toContainEqual({
      instanceId: 'i-1234',
      launchTime: new Date('2020-10-10T14:48:00.000+09:00'),
      repo: 'CoderToCat/hello-world',
      org: 'CoderToCat',
    });
    expect(resp).toContainEqual({
      instanceId: 'i-5678',
      launchTime: new Date('2020-10-11T14:48:00.000+09:00'),
      repo: 'SomeAwesomeCoder/some-amazing-library',
      org: 'SomeAwesomeCoder',
    });
  });

  it('calls EC2 describe instances', async () => {
    await listRunners();
    expect(mockEC2.describeInstances).toBeCalled();
  });

  it('filters instances on repo name', async () => {
    await listRunners({ repoName: 'SomeAwesomeCoder/some-amazing-library' });
    expect(mockEC2.describeInstances).toBeCalledWith({
      Filters: [
        { Name: 'tag:Application', Values: ['github-action-runner'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
        { Name: 'tag:Repo', Values: ['SomeAwesomeCoder/some-amazing-library'] },
      ],
    });
  });

  it('filters instances on org name', async () => {
    await listRunners({ orgName: 'SomeAwesomeCoder' });
    expect(mockEC2.describeInstances).toBeCalledWith({
      Filters: [
        { Name: 'tag:Application', Values: ['github-action-runner'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
        { Name: 'tag:Org', Values: ['SomeAwesomeCoder'] },
      ],
    });
  });

  it('filters instances on org name', async () => {
    await listRunners({ environment: 'unit-test-environment' });
    expect(mockEC2.describeInstances).toBeCalledWith({
      Filters: [
        { Name: 'tag:Application', Values: ['github-action-runner'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
        { Name: 'tag:Environment', Values: ['unit-test-environment'] },
      ],
    });
  });

  it('filters instances on both org name and repo name', async () => {
    await listRunners({ orgName: 'SomeAwesomeCoder', repoName: 'SomeAwesomeCoder/some-amazing-library' });
    expect(mockEC2.describeInstances).toBeCalledWith({
      Filters: [
        { Name: 'tag:Application', Values: ['github-action-runner'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
        { Name: 'tag:Repo', Values: ['SomeAwesomeCoder/some-amazing-library'] },
        { Name: 'tag:Org', Values: ['SomeAwesomeCoder'] },
      ],
    });
  });
});

describe('terminateRunner', () => {
  beforeEach(() => {
    jest.mock('aws-sdk', () => ({
      EC2: jest.fn().mockImplementation(() => mockEC2),
    }));
  });

  it('calls terminateInstances', async () => {
    const runner: RunnerInfo = {
      instanceId: '1234',
    };

    await terminateRunner(runner);

    expect(mockEC2.terminateInstances).toBeCalledWith({
      InstanceIds: [runner.instanceId],
    });
  });
});

describe('create runner', () => {
  const mockRunInstances = { promise: jest.fn() };
  const mockPutParameter = { promise: jest.fn() };
  const subnetIds = ['sub-1234', 'sub-4321'];
  const config = {
    launchTemplateNameLinux: 'launch-template-name-linux',
    launchTemplateVersionLinux: '1-linux',
    launchTemplateNameWindows: 'launch-template-name-windows',
    launchTemplateVersionWindows: '1-windows',
    subnetIds: subnetIds,
    shuffledSubnetIds: subnetIds,
    securityGroupIds: ['123', '321', '456'],
  };

  beforeEach(() => {
    mockEC2.runInstances.mockImplementation(() => mockRunInstances);
    mockRunInstances.promise.mockReturnValue({
      Instances: [
        {
          InstanceId: 'i-1234',
        },
      ],
    });
    mockSSM.putParameter.mockImplementation(() => mockPutParameter);

    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
  });

  it('calls run instances with the correct config for repo && linux', async () => {
    const runnerParameters = {
      runnerConfig: 'bla',
      environment: 'unit-test-env',
      repoName: 'SomeAwesomeCoder/some-amazing-library',
      orgName: undefined,
      runnerType: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
        is_ephemeral: true,
      },
    };

    await createRunner(runnerParameters);

    expect(mockEC2.runInstances).toHaveBeenCalledTimes(1);
    expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 0));
  });

  it('calls run instances with the correct config for repo && windows', async () => {
    const runnerParameters = {
      runnerConfig: 'bla',
      environment: 'unit-test-env',
      repoName: 'SomeAwesomeCoder/some-amazing-library',
      orgName: undefined,
      runnerType: {
        instance_type: 'c5.2xlarge',
        os: 'windows',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
        is_ephemeral: true,
      },
    };

    await createRunner(runnerParameters);

    expect(mockEC2.runInstances).toHaveBeenCalledTimes(1);
    expect(mockEC2.runInstances).toBeCalledWith({
      MaxCount: 1,
      MinCount: 1,
      LaunchTemplate: {
        LaunchTemplateName: Config.Instance.launchTemplateNameWindows,
        Version: Config.Instance.launchTemplateVersionWindows,
      },
      InstanceType: runnerParameters.runnerType.instance_type,
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/sda1',
          Ebs: {
            VolumeSize: runnerParameters.runnerType.disk_size,
            VolumeType: 'gp3',
            Encrypted: true,
            DeleteOnTermination: true,
          },
        },
      ],
      NetworkInterfaces: [
        {
          AssociatePublicIpAddress: true,
          SubnetId: Config.Instance.shuffledSubnetIds[0],
          Groups: Config.Instance.securityGroupIds,
          DeviceIndex: 0,
        },
      ],
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Application', Value: 'github-action-runner' },
            {
              Key: 'Repo',
              Value: runnerParameters.repoName,
            },
            { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName },
          ],
        },
      ],
    });
  });

  it('creates ssm parameters for each created instance', async () => {
    await createRunner({
      runnerConfig: 'bla',
      environment: 'unit-test-env',
      repoName: 'SomeAwesomeCoder/some-amazing-library',
      orgName: undefined,
      runnerType: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
        is_ephemeral: true,
      },
    });
    expect(mockSSM.putParameter).toBeCalledWith({
      Name: 'unit-test-env-i-1234',
      Value: 'bla',
      Type: 'SecureString',
    });
  });

  it('does not create ssm parameters when no instance is created', async () => {
    mockRunInstances.promise.mockReturnValue({
      Instances: [],
    });
    await createRunner({
      runnerConfig: 'bla',
      environment: 'unit-test-env',
      repoName: 'SomeAwesomeCoder/some-amazing-library',
      orgName: undefined,
      runnerType: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
        is_ephemeral: true,
      },
    });
    expect(mockSSM.putParameter).not.toBeCalled();
  });

  it('fails to attach in both networks and raises exception', async () => {
    const errorMsg = 'test error msg';
    mockEC2.runInstances.mockImplementation(() => {
      throw Error(errorMsg);
    });
    const runnerParameters = {
      runnerConfig: 'bla',
      environment: 'unit-test-env',
      repoName: 'SomeAwesomeCoder/some-amazing-library',
      orgName: undefined,
      runnerType: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
        is_ephemeral: true,
      },
    };

    await expect(createRunner(runnerParameters)).rejects.toThrow(errorMsg);

    expect(mockEC2.runInstances).toHaveBeenCalledTimes(2);
    expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 0));
    expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 1));

    expect(mockSSM.putParameter).not.toBeCalled();
  });
});

describe('getRepo', () => {
  it('returns the repo from single string', () => {
    expect(getRepo('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns the repo from two strings', () => {
    expect(getRepo('owner', 'repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('throws error when repoDef is not in the correct format', () => {
    expect(() => {
      getRepo('owner/repo/invalid');
    }).toThrowError();
  });
});

describe('resetRunnersCaches', () => {
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
      mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
      mockCreateOctoClient.mockResolvedValueOnce(expectedReturn as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
      mockCreateOctoClient.mockResolvedValueOnce(expectedReturn as unknown as Octokit);
    }

    resetRunnersCaches();
    expect(await listGithubRunners(repo)).toEqual(irrelevantRunner);
    expect(await createGitHubClientForRunner(repo)).toEqual(expectedReturn);

    resetRunnersCaches();
    expect(await listGithubRunners(repo)).toEqual(irrelevantRunner);
    expect(await createGitHubClientForRunner(repo)).toEqual(expectedReturn);

    expect(expectedReturn.paginate).toBeCalledTimes(2);
    expect(mockCreateGithubAuth).toHaveBeenCalledTimes(4);
    expect(mockCreateOctoClient).toHaveBeenCalledTimes(4);
  });
});

describe('createGitHubClientForRunner', () => {
  const config = {
    ghesUrlApi: undefined,
  };

  beforeEach(() => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce({
      apps: { getRepoInstallation: getRepoInstallation },
    } as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(expectedReturn as unknown as Octokit);

    resetRunnersCaches();
    expect(await createGitHubClientForRunner(repo)).toEqual(expectedReturn);
    expect(await createGitHubClientForRunner(repo)).toEqual(expectedReturn);

    expect(mockCreateGithubAuth).toHaveBeenCalledTimes(2);
    expect(mockCreateOctoClient).toHaveBeenCalledTimes(2);

    expect(mockCreateGithubAuth).toHaveBeenCalledWith(undefined, 'app', undefined);
    expect(mockCreateOctoClient).toHaveBeenCalledWith('token1', undefined);
    expect(getRepoInstallation).toHaveBeenCalledWith(repo);
    expect(mockCreateGithubAuth).toHaveBeenCalledWith('mockReturnValueOnce1', 'installation', undefined);
    expect(mockCreateOctoClient).toHaveBeenCalledWith('token2', undefined);
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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    expect(await listGithubRunners(repo)).toEqual(irrelevantRunner);
    expect(await listGithubRunners(repo)).toEqual(irrelevantRunner);

    expect(mockedOctokit.paginate).toBeCalledTimes(1);
    expect(mockedOctokit.paginate).toBeCalledWith('', {
      owner: 'owner',
      repo: 'repo',
      per_page: 100,
    });
  });
});

describe('removeGithubRunner', () => {
  const repo = { owner: 'owner', repo: 'repo' };
  const irrelevantRunnerInfo: RunnerInfo = {
    ...repo,
    instanceId: '113',
  };

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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    await removeGithubRunner(irrelevantRunnerInfo, runnerId, repo);

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromRepo).toBeCalledWith({
      ...repo,
      runner_id: runnerId,
    });
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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    await removeGithubRunner(irrelevantRunnerInfo, runnerId, repo);
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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    expect(await getRunner(repo, '1234')).toEqual(irrelevantRunner);

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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    expect(await getRunner({ owner: 'owner', repo: 'repo' }, '1234')).toEqual(undefined);
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
          status: 200,
        }),
      },
    };

    // for (let i = 0; i < 2; i++) {
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    // }

    resetRunnersCaches();
    expect(await getRunnerTypes(repo)).toEqual(
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
    expect(await getRunnerTypes(repo)).toEqual(
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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    await expect(getRunnerTypes(repo)).rejects.toThrow(Error);
  });
});

describe('createRegistrationTokenForRepo', () => {
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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    expect(await createRegistrationTokenForRepo(repo)).toEqual(testToken);
    expect(await createRegistrationTokenForRepo(repo)).toEqual(testToken);
    expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledTimes(1);
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

    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token1' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce({ token: 'token2' } as unknown as Authentication);
    mockCreateOctoClient.mockResolvedValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    await expect(createRegistrationTokenForRepo(repo)).rejects.toThrow(Error);
    expect(mockedOctokit.actions.createRegistrationTokenForRepo).toBeCalledTimes(1);
  });
});
