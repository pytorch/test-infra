import {
  RunnerInputParameters,
  createRunner,
  getParameterNameForRunner,
  listRunners,
  listSSMParameters,
  resetRunnersCaches,
  terminateRunner,
} from './runners';
import { RunnerInfo } from './utils';
import { ScaleUpMetrics } from './metrics';

import { Config } from './config';
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

describe('listSSMParameters', () => {
  beforeEach(() => {
    mockSSMdescribeParametersRet.mockClear();

    resetRunnersCaches();
  });

  it('calls twice, check if cached, resets cache, calls again', async () => {
    const api1 = ['lalala', 'helloWorld'];
    const api2 = ['asdf', 'fdsa'];
    const api3 = ['AGDGADUWG113', '33'];
    const ret1 = new Set(api1.concat(api2));
    const ret2 = new Set(api3);

    mockSSMdescribeParametersRet.mockResolvedValueOnce({
      NextToken: 'token',
      Parameters: api1.map((s) => {
        return { Name: s };
      }),
    });
    mockSSMdescribeParametersRet.mockResolvedValueOnce({
      Parameters: api2.map((s) => {
        return { Name: s };
      }),
    });
    mockSSMdescribeParametersRet.mockResolvedValueOnce({
      Parameters: api3.map((s) => {
        return { Name: s };
      }),
    });

    await expect(listSSMParameters(metrics)).resolves.toEqual(ret1);
    await expect(listSSMParameters(metrics)).resolves.toEqual(ret1);
    resetRunnersCaches();
    await expect(listSSMParameters(metrics)).resolves.toEqual(ret2);

    expect(mockSSMdescribeParametersRet).toBeCalledTimes(3);
    expect(mockSSM.describeParameters).toBeCalledWith();
    expect(mockSSM.describeParameters).toBeCalledWith({ NextToken: 'token' });
    expect(mockSSM.describeParameters).toBeCalledWith();
  });
});

describe('terminateRunner', () => {
  beforeEach(() => {
    mockSSMdescribeParametersRet.mockClear();

    resetRunnersCaches();
  });

  it('calls terminateInstances', async () => {
    const runner: RunnerInfo = {
      instanceId: '1234',
      environment: 'environ',
    };
    mockSSMdescribeParametersRet.mockResolvedValueOnce({
      Parameters: [getParameterNameForRunner(runner.environment as string, runner.instanceId)].map((s) => {
        return { Name: s };
      }),
    });
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
