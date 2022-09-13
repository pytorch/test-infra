import {
  GhRunners,
  RunnerInputParameters,
  createGitHubClientForRunnerInstallId,
  createGitHubClientForRunnerOrg,
  createGitHubClientForRunnerRepo,
  createRegistrationTokenOrg,
  createRegistrationTokenRepo,
  createRunner,
  getRunnerOrg,
  getRunnerRepo,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  listRunners,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetRunnersCaches,
  terminateRunner,
} from './runners';
import { RunnerInfo } from './utils';
import { createGithubAuth, createOctoClient } from './gh-auth';
import { ScaleUpMetrics } from './metrics';

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
  CloudWatch: jest.requireActual('aws-sdk').CloudWatch,
}));

jest.mock('./gh-auth');

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

function createExpectedRunInstancesLinux(runnerParameters: RunnerInputParameters, subnetId: number, enableOrg = false) {
  const tags = [
    { Key: 'Application', Value: 'github-action-runner' },
    { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName },
  ];
  if (enableOrg) {
    tags.push({
      Key: 'Org',
      Value: runnerParameters.orgName as string,
    });
  } else {
    tags.push({
      Key: 'Repo',
      Value: runnerParameters.repoName as string,
    });
  }
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
        Tags: tags,
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
    mockDescribeInstances.promise.mockResolvedValue(mockRunningInstances);
  });

  it('ec2 fails', async () => {
    const errMsg = 'Error message';
    mockDescribeInstances.promise.mockClear().mockRejectedValue(Error(errMsg));
    expect(listRunners(metrics)).rejects.toThrowError(errMsg);
  });

  it('returns a list of instances', async () => {
    const resp = await listRunners(metrics);
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
    await listRunners(metrics);
    expect(mockEC2.describeInstances).toBeCalled();
  });

  it('filters instances on repo name', async () => {
    await listRunners(metrics, { repoName: 'SomeAwesomeCoder/some-amazing-library' });
    expect(mockEC2.describeInstances).toBeCalledWith({
      Filters: [
        { Name: 'tag:Application', Values: ['github-action-runner'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
        { Name: 'tag:Repo', Values: ['SomeAwesomeCoder/some-amazing-library'] },
      ],
    });
  });

  it('filters instances on org name', async () => {
    await listRunners(metrics, { orgName: 'SomeAwesomeCoder' });
    expect(mockEC2.describeInstances).toBeCalledWith({
      Filters: [
        { Name: 'tag:Application', Values: ['github-action-runner'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
        { Name: 'tag:Org', Values: ['SomeAwesomeCoder'] },
      ],
    });
  });

  it('filters instances on org name', async () => {
    await listRunners(metrics, { environment: 'unit-test-environment' });
    expect(mockEC2.describeInstances).toBeCalledWith({
      Filters: [
        { Name: 'tag:Application', Values: ['github-action-runner'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
        { Name: 'tag:Environment', Values: ['unit-test-environment'] },
      ],
    });
  });

  it('filters instances on both org name and repo name', async () => {
    await listRunners(metrics, { orgName: 'SomeAwesomeCoder', repoName: 'SomeAwesomeCoder/some-amazing-library' });
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

    await terminateRunner(runner, metrics);

    expect(mockEC2.terminateInstances).toBeCalledWith({
      InstanceIds: [runner.instanceId],
    });
  });

  it('fails to terminate', async () => {
    const errMsg = 'Error message';
    const runner: RunnerInfo = {
      instanceId: '1234',
    };
    mockEC2.terminateInstances.mockClear().mockReturnValue({
      promise: jest.fn().mockRejectedValueOnce(Error(errMsg)),
    });
    expect(terminateRunner(runner, metrics)).rejects.toThrowError(errMsg);
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

    await createRunner(runnerParameters, metrics);

    expect(mockEC2.runInstances).toHaveBeenCalledTimes(1);
    expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 0));
  });

  it('calls run instances with the correct config for repo && linux && organization', async () => {
    const runnerParameters = {
      runnerConfig: 'bla',
      environment: 'unit-test-env',
      repoName: undefined,
      orgName: 'SomeAwesomeCoder',
      runnerType: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
        is_ephemeral: true,
      },
    };

    await createRunner(runnerParameters, metrics);

    expect(mockEC2.runInstances).toHaveBeenCalledTimes(1);
    expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 0, true));
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

    await createRunner(runnerParameters, metrics);

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
            { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName },
            {
              Key: 'Repo',
              Value: runnerParameters.repoName,
            },
          ],
        },
      ],
    });
  });

  it('creates ssm parameters for each created instance', async () => {
    await createRunner(
      {
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
      },
      metrics,
    );
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
    await createRunner(
      {
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
      },
      metrics,
    );
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

    await expect(createRunner(runnerParameters, metrics)).rejects.toThrow(errorMsg);

    expect(mockEC2.runInstances).toHaveBeenCalledTimes(2);
    expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 0));
    expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 1));

    expect(mockSSM.putParameter).not.toBeCalled();
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
      mockCreateGithubAuth.mockResolvedValueOnce('token1');
      mockCreateOctoClient.mockReturnValue(expectedReturn as unknown as Octokit);
      mockCreateGithubAuth.mockResolvedValueOnce('token2');
      mockCreateOctoClient.mockReturnValue(expectedReturn as unknown as Octokit);
    }

    resetRunnersCaches();
    expect(await listGithubRunnersRepo(repo, metrics)).toEqual(irrelevantRunner);
    expect(await createGitHubClientForRunnerRepo(repo, metrics)).toEqual(expectedReturn);

    resetRunnersCaches();
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

      resetRunnersCaches();
      expect(createGitHubClientForRunnerRepo(repo, metrics)).rejects.toThrowError(errMsg);
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

      resetRunnersCaches();
      expect(createGitHubClientForRunnerRepo(repo, metrics)).rejects.toThrowError(errMsg);
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
      expect(createGitHubClientForRunnerOrg(org, metrics)).rejects.toThrowError(errMsg);
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

      resetRunnersCaches();
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

      resetRunnersCaches();
      expect(createGitHubClientForRunnerInstallId(installId, metrics)).rejects.toThrowError(errMsg);
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

      resetRunnersCaches();
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

      resetRunnersCaches();
      expect(listGithubRunnersRepo(repo, metrics)).rejects.toThrowError(errMsg);
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

      resetRunnersCaches();
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

      resetRunnersCaches();
      expect(listGithubRunnersOrg(org, metrics)).rejects.toThrowError(errMsg);
    });
  });
});

describe('removeGithubRunnerRepo', () => {
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

    mockCreateGithubAuth.mockResolvedValueOnce('token1');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce('token2');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    await removeGithubRunnerRepo(irrelevantRunnerInfo, runnerId, repo, metrics);

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromRepo).toBeCalledWith({
      ...repo,
      runner_id: runnerId,
    });
    expect(getRepoInstallation).toBeCalled();
    expect(mockEC2.terminateInstances).toBeCalledWith({
      InstanceIds: [irrelevantRunnerInfo.instanceId],
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

    mockCreateGithubAuth.mockResolvedValueOnce('token1');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);
    mockCreateGithubAuth.mockResolvedValueOnce('token2');
    mockCreateOctoClient.mockReturnValueOnce(mockedOctokit as unknown as Octokit);

    resetRunnersCaches();
    await removeGithubRunnerRepo(irrelevantRunnerInfo, runnerId, repo, metrics);

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromRepo).toBeCalledWith({
      ...repo,
      runner_id: runnerId,
    });
    expect(getRepoInstallation).toBeCalled();
    expect(mockEC2.terminateInstances).not.toBeCalled();
  });
});

describe('removeGithubRunnerOrg', () => {
  const org = 'mockedOrg';
  const irrelevantRunnerInfo: RunnerInfo = {
    org: org,
    instanceId: '113',
  };

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

    resetRunnersCaches();
    await removeGithubRunnerOrg(irrelevantRunnerInfo, runnerId, org, metrics);

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromOrg).toBeCalledWith({
      org: org,
      runner_id: runnerId,
    });
    expect(getOrgInstallation).toBeCalled();
    expect(mockEC2.terminateInstances).toBeCalledWith({
      InstanceIds: [irrelevantRunnerInfo.instanceId],
    });
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

    resetRunnersCaches();
    await removeGithubRunnerOrg(irrelevantRunnerInfo, runnerId, org, metrics);

    expect(mockedOctokit.actions.deleteSelfHostedRunnerFromOrg).toBeCalledWith({
      org: org,
      runner_id: runnerId,
    });
    expect(getOrgInstallation).toBeCalled();
    expect(mockEC2.terminateInstances).not.toBeCalled();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

    resetRunnersCaches();
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

    resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
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

      resetRunnersCaches();
      await expect(createRegistrationTokenOrg(org, metrics)).rejects.toThrow(Error);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledTimes(1);
      expect(mockedOctokit.actions.createRegistrationTokenForOrg).toBeCalledWith({ org: org });
    });
  });
});
