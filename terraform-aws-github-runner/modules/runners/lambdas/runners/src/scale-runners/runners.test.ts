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

const runnerConfigFn = jest.fn().mockImplementation((awsRegion: string) => {
  return `${awsRegion}-BLAH`;
});
const mockEC2runInstances = jest.fn();
const mockEC2terminateInstances = jest.fn();
const mockEC2 = {
  describeInstances: jest.fn(),
  runInstances: jest.fn().mockReturnValue({ promise: mockEC2runInstances }),
  terminateInstances: jest.fn().mockReturnValue({ promise: mockEC2terminateInstances }),
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
jest.mock('./utils', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./utils') as any),
  shuffleArrayInPlace: <T>(a: Array<T>) => a.sort(),
}));

jest.mock('./gh-auth');

function createExpectedRunInstancesLinux(
  runnerParameters: RunnerInputParameters,
  subnetId: number,
  enableOrg = false,
  vpcIdx: string | undefined = undefined,
) {
  const vpcId = vpcIdx ?? Config.Instance.shuffledVPCsForAwsRegion(Config.Instance.awsRegion)[0];
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
  const secGroup = Config.Instance.vpcIdToSecurityGroupIds.get(vpcId) || [];
  const snetId = ['sub-0113', 'sub-7777', 'sub-1234', 'sub-4321', 'sub-1235', 'sub-4322'][subnetId];
  return {
    MaxCount: 1,
    MinCount: 1,
    LaunchTemplate: {
      LaunchTemplateName: runnerParameters.runnerType.runnerTypeName.includes('.nvidia.gpu')
        ? Config.Instance.launchTemplateNameLinuxNvidia
        : Config.Instance.launchTemplateNameLinux,
      Version: runnerParameters.runnerType.runnerTypeName.includes('.nvidia.gpu')
        ? Config.Instance.launchTemplateVersionLinuxNvidia
        : Config.Instance.launchTemplateVersionLinux,
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
        Ipv6AddressCount: 1,
        AssociatePublicIpAddress: true,
        SubnetId: snetId,
        Groups: secGroup,
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
  const config = {
    awsRegion: 'us-east-1',
    shuffledAwsRegionInstances: ['us-east-1'],
  };

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
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
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
      awsRegion: Config.Instance.awsRegion,
      instanceId: 'i-1234',
      launchTime: new Date('2020-10-10T14:48:00.000+09:00'),
      repo: 'CoderToCat/hello-world',
      org: 'CoderToCat',
    });
    expect(resp).toContainEqual({
      awsRegion: Config.Instance.awsRegion,
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

    await expect(listSSMParameters(metrics, Config.Instance.awsRegion)).resolves.toEqual(ret1);
    await expect(listSSMParameters(metrics, Config.Instance.awsRegion)).resolves.toEqual(ret1);
    resetRunnersCaches();
    await expect(listSSMParameters(metrics, Config.Instance.awsRegion)).resolves.toEqual(ret2);

    expect(mockSSMdescribeParametersRet).toBeCalledTimes(3);
    expect(mockSSM.describeParameters).toBeCalledWith();
    expect(mockSSM.describeParameters).toBeCalledWith({ NextToken: 'token' });
    expect(mockSSM.describeParameters).toBeCalledWith();
  });
});

describe('terminateRunner', () => {
  beforeEach(() => {
    mockSSMdescribeParametersRet.mockClear();
    mockEC2.terminateInstances.mockClear();

    resetRunnersCaches();
  });

  it('calls terminateInstances', async () => {
    const runner: RunnerInfo = {
      awsRegion: Config.Instance.awsRegion,
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
    expect(mockSSM.describeParameters).toBeCalledTimes(1);
    expect(mockSSM.deleteParameter).toBeCalledTimes(1);
    expect(mockSSM.deleteParameter).toBeCalledWith({
      Name: getParameterNameForRunner(runner.environment as string, runner.instanceId),
    });
  });

  it('fails to terminate', async () => {
    const errMsg = 'Error message';
    const runner: RunnerInfo = {
      awsRegion: Config.Instance.awsRegion,
      instanceId: '1234',
    };
    mockEC2.terminateInstances.mockClear().mockReturnValue({
      promise: jest.fn().mockRejectedValueOnce(Error(errMsg)),
    });
    expect(terminateRunner(runner, metrics)).rejects.toThrowError(errMsg);
    expect(mockSSM.describeParameters).not.toBeCalled();
    expect(mockSSM.deleteParameter).not.toBeCalled();
  });

  it('fails to list parameters on terminate, then force delete all next parameters', async () => {
    const runner1: RunnerInfo = {
      awsRegion: Config.Instance.awsRegion,
      instanceId: '1234',
      environment: 'environ',
    };
    const runner2: RunnerInfo = {
      awsRegion: Config.Instance.awsRegion,
      instanceId: '1235',
      environment: 'environ',
    };
    mockSSMdescribeParametersRet.mockRejectedValueOnce('Some Error');
    await terminateRunner(runner1, metrics);
    await terminateRunner(runner2, metrics);

    expect(mockEC2.terminateInstances).toBeCalledTimes(2);
    expect(mockSSM.describeParameters).toBeCalledTimes(1);
    expect(mockSSM.deleteParameter).toBeCalledTimes(2);
    expect(mockSSM.deleteParameter).toBeCalledWith({
      Name: getParameterNameForRunner(runner1.environment as string, runner1.instanceId),
    });
    expect(mockSSM.deleteParameter).toBeCalledWith({
      Name: getParameterNameForRunner(runner2.environment as string, runner2.instanceId),
    });
  });
});

describe('createRunner', () => {
  describe('single region', () => {
    const mockRunInstances = { promise: jest.fn() };
    const mockPutParameter = { promise: jest.fn() };
    const regionToVpc = new Map([['us-east-1', ['vpc-agdgaduwg113']]]);
    const config = {
      launchTemplateNameLinux: 'launch-template-name-linux',
      launchTemplateVersionLinux: '1-linux',
      launchTemplateNameWindows: 'launch-template-name-windows',
      launchTemplateVersionWindows: '1-windows',
      awsRegion: 'us-east-1',
      shuffledAwsRegionInstances: ['us-east-1'],
      awsRegionsToVpcIds: regionToVpc,
      subnetIdToAZ: new Map([
        ['sub-1234', 'us-east-1a'],
        ['sub-4321', 'us-east-1b'],
        ['sub-0113', 'us-east-1c'],
        ['sub-7777', 'us-east-1c'],
      ]),
      azToSubnetIds: new Map([
        ['us-east-1a', ['sub-1234']],
        ['us-east-1b', ['sub-4321']],
        ['us-east-1c', ['sub-0113', 'sub-7777']],
      ]),
      vpcIdToSubnetIds: new Map([['vpc-agdgaduwg113', ['sub-1234', 'sub-4321', 'sub-0113', 'sub-7777']]]),
      subnetIdToVpcId: new Map([
        ['sub-1234', 'vpc-agdgaduwg113'],
        ['sub-4321', 'vpc-agdgaduwg113'],
        ['sub-0113', 'vpc-agdgaduwg113'],
        ['sub-7777', 'vpc-agdgaduwg113'],
      ]),
      vpcIdToSecurityGroupIds: new Map([['vpc-agdgaduwg113', ['sg1', 'sg2']]]),
      shuffledVPCsForAwsRegion: jest.fn().mockImplementation(() => {
        return ['vpc-agdgaduwg113'];
      }),
    };
    const mockDescribeInstances = { promise: jest.fn() };

    beforeEach(() => {
      mockEC2.describeInstances.mockImplementation(() => mockDescribeInstances);
      const mockRunningInstances: AWS.EC2.DescribeInstancesResult = {
        Reservations: [
          {
            Instances: [
              {
                LaunchTime: new Date('2020-10-10T14:48:00.000+09:00'),
                InstanceId: 'i-0113',
                Placement: {
                  AvailabilityZone: 'us-east-1a',
                },
                Tags: [
                  { Key: 'Repo', Value: 'CoderToCat/hello-world' },
                  { Key: 'Org', Value: 'CoderToCat' },
                  { Key: 'Application', Value: 'github-action-runner' },
                ],
              },
              {
                LaunchTime: new Date('2020-10-10T14:48:00.000+09:00'),
                InstanceId: 'i-1234',
                Placement: {
                  AvailabilityZone: 'us-east-1b',
                },
                Tags: [
                  { Key: 'Repo', Value: 'CoderToCat/hello-world' },
                  { Key: 'Org', Value: 'CoderToCat' },
                  { Key: 'Application', Value: 'github-action-runner' },
                ],
              },
              {
                LaunchTime: new Date('2020-10-11T14:48:00.000+09:00'),
                InstanceId: 'i-5678',
                Placement: {
                  AvailabilityZone: 'us-east-1b',
                },
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
        runnerConfig: runnerConfigFn,
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
      expect(runnerConfigFn).toBeCalledTimes(1);
      expect(runnerConfigFn).toBeCalledWith(config.awsRegion);
    });

    it('calls run instances with the correct config for repo && linux && organization', async () => {
      const runnerParameters = {
        runnerConfig: runnerConfigFn,
        environment: 'unit-test-env',
        repoName: undefined,
        orgName: 'SomeAwesomeCoder',
        runnerType: {
          instance_type: 'c5.2xlarge',
          os: 'linux',
          max_available: 200,
          disk_size: 100,
          runnerTypeName: 'linuxCpu.nvidia.gpu',
          is_ephemeral: true,
        },
      };

      await createRunner(runnerParameters, metrics);

      expect(mockEC2.runInstances).toHaveBeenCalledTimes(1);
      expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 0, true));
      expect(runnerConfigFn).toBeCalledTimes(1);
      expect(runnerConfigFn).toBeCalledWith(config.awsRegion);
    });

    it('calls run instances with the correct config for repo && windows', async () => {
      const runnerParameters = {
        runnerConfig: runnerConfigFn,
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

      expect(runnerConfigFn).toBeCalledTimes(1);
      expect(runnerConfigFn).toBeCalledWith(config.awsRegion);
      expect(mockEC2.runInstances).toHaveBeenCalledTimes(1);
      const secGroup = Config.Instance.vpcIdToSecurityGroupIds.get('vpc-agdgaduwg113') || [];
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
            Ipv6AddressCount: 1,
            AssociatePublicIpAddress: true,
            SubnetId: 'sub-0113',
            Groups: secGroup,
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
          runnerConfig: runnerConfigFn,
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
      expect(runnerConfigFn).toBeCalledTimes(1);
      expect(runnerConfigFn).toBeCalledWith(config.awsRegion);
      expect(mockSSM.putParameter).toBeCalledTimes(1);
      expect(mockSSM.putParameter).toBeCalledWith({
        Name: 'unit-test-env-i-1234',
        Value: 'us-east-1-BLAH',
        Type: 'SecureString',
      });
    });

    it('does not create ssm parameters when no instance is created', async () => {
      mockRunInstances.promise.mockReturnValue({
        Instances: [],
      });
      await expect(
        createRunner(
          {
            runnerConfig: runnerConfigFn,
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
        ),
      ).rejects.toThrow();
      expect(runnerConfigFn).toBeCalledTimes(0);
      expect(mockSSM.putParameter).not.toBeCalled();
    });

    it('fails to attach to any network and raises exception', async () => {
      const errorMsg = 'test error msg ASDF';
      mockRunInstances.promise.mockClear().mockRejectedValue(new Error(errorMsg));
      const runnerParameters = {
        runnerConfig: runnerConfigFn,
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

      await expect(createRunner(runnerParameters, metrics)).rejects.toThrow();

      expect(runnerConfigFn).toBeCalledTimes(0);
      expect(mockEC2.runInstances).toHaveBeenCalledTimes(4);
      expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 0));
      expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 1));
      expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 2));
      expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 3));

      expect(mockSSM.putParameter).not.toBeCalled();
    });
  });

  describe('multiregion', () => {
    const mockRunInstances = { promise: jest.fn() };
    const mockPutParameter = { promise: jest.fn() };
    const regionToVpc = new Map([
      ['us-east-1', ['vpc-agdgaduwg113-11', 'vpc-agdgaduwg113-12']],
      ['us-west-1', ['vpc-agdgaduwg113-21', 'vpc-agdgaduwg113-22']],
    ]);
    const vpcToSg = new Map([
      ['vpc-agdgaduwg113-11', ['sg1', 'sg2']],
      ['vpc-agdgaduwg113-12', ['sg3', 'sg4']],
      ['vpc-agdgaduwg113-21', ['sg5', 'sg6']],
      ['vpc-agdgaduwg113-22', ['sg7', 'sg8']],
    ]);
    const config = {
      launchTemplateNameLinux: 'launch-template-name-linux',
      launchTemplateVersionLinux: '1-linux',
      launchTemplateNameWindows: 'launch-template-name-windows',
      launchTemplateVersionWindows: '1-windows',
      awsRegion: 'us-east-1',
      awsRegionsToVpcIds: regionToVpc,
      subnetIdToAZ: new Map([
        ['sub-1234', 'us-east-1a'],
        ['sub-1235', 'us-east-1a'],
        ['sub-4321', 'us-east-1b'],
        ['sub-4322', 'us-east-1b'],
        ['sub-1130', 'us-west-1a'],
        ['sub-1131', 'us-west-1a'],
        ['sub-0113', 'us-west-1b'],
        ['sub-1113', 'us-west-1b'],
      ]),
      azToSubnetIds: new Map([
        ['us-east-1a', ['sub-1234', 'sub-1235']],
        ['us-east-1b', ['sub-4321', 'sub-4322']],
        ['us-west-1a', ['sub-1130', 'sub-1131']],
        ['us-west-1b', ['sub-0113', 'sub-1113']],
      ]),
      vpcIdToSubnetIds: new Map([
        ['vpc-agdgaduwg113-11', ['sub-1234', 'sub-4321']],
        ['vpc-agdgaduwg113-12', ['sub-1235', 'sub-4322']],
        ['vpc-agdgaduwg113-21', ['sub-1130', 'sub-0113']],
        ['vpc-agdgaduwg113-22', ['sub-1131', 'sub-1113']],
      ]),
      subnetIdToVpcId: new Map([
        ['sub-1234', 'vpc-agdgaduwg113-11'],
        ['sub-1235', 'vpc-agdgaduwg113-12'],
        ['sub-4321', 'vpc-agdgaduwg113-11'],
        ['sub-4322', 'vpc-agdgaduwg113-12'],
        ['sub-1130', 'vpc-agdgaduwg113-21'],
        ['sub-1131', 'vpc-agdgaduwg113-22'],
        ['sub-0113', 'vpc-agdgaduwg113-21'],
        ['sub-1113', 'vpc-agdgaduwg113-22'],
      ]),
      shuffledAwsRegionInstances: ['us-east-1', 'us-west-1'],
      vpcIdToSecurityGroupIds: vpcToSg,
      shuffledVPCsForAwsRegion: jest.fn().mockImplementation((awsRegion: string) => {
        return Array.from(regionToVpc.get(awsRegion) ?? []);
      }),
    };
    const runInstanceSuccess = {
      Instances: [
        {
          InstanceId: 'i-1234',
        },
      ],
    };
    const mockDescribeInstances = { promise: jest.fn() };

    beforeEach(() => {
      mockEC2.runInstances.mockImplementation(() => mockRunInstances);
      mockRunInstances.promise.mockReturnValue(runInstanceSuccess);
      mockSSM.putParameter.mockImplementation(() => mockPutParameter);
      mockEC2.describeInstances.mockImplementation(() => mockDescribeInstances);
      const mockRunningInstances: AWS.EC2.DescribeInstancesResult = {
        Reservations: [
          {
            Instances: [
              {
                LaunchTime: new Date('2020-10-10T14:48:00.000+09:00'),
                InstanceId: 'i-0113',
                Placement: {
                  AvailabilityZone: 'us-east-1a',
                },
                Tags: [
                  { Key: 'Repo', Value: 'CoderToCat/hello-world' },
                  { Key: 'Org', Value: 'CoderToCat' },
                  { Key: 'Application', Value: 'github-action-runner' },
                ],
              },
              {
                LaunchTime: new Date('2020-10-10T14:48:00.000+09:00'),
                InstanceId: 'i-1234',
                Placement: {
                  AvailabilityZone: 'us-east-1b',
                },
                Tags: [
                  { Key: 'Repo', Value: 'CoderToCat/hello-world' },
                  { Key: 'Org', Value: 'CoderToCat' },
                  { Key: 'Application', Value: 'github-action-runner' },
                ],
              },
              {
                LaunchTime: new Date('2020-10-11T14:48:00.000+09:00'),
                InstanceId: 'i-5678',
                Placement: {
                  AvailabilityZone: 'us-east-1b',
                },
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
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    });

    it('succeed in the first try, first subnet and region', async () => {
      const runnerParameters = {
        runnerConfig: runnerConfigFn,
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

      expect(await createRunner(runnerParameters, metrics)).toEqual(config.shuffledAwsRegionInstances[0]);

      expect(mockEC2.runInstances).toHaveBeenCalledTimes(1);
      expect(mockEC2.runInstances).toBeCalledWith(createExpectedRunInstancesLinux(runnerParameters, 2));
      expect(runnerConfigFn).toBeCalledTimes(1);
      expect(runnerConfigFn).toBeCalledWith(config.shuffledAwsRegionInstances[0]);
    });

    it('succeed, 2nd subnet and 1st region', async () => {
      mockRunInstances.promise.mockClear().mockRejectedValueOnce(new Error('test error msg'));
      mockRunInstances.promise.mockClear().mockResolvedValueOnce(runInstanceSuccess);

      const runnerParameters = {
        runnerConfig: runnerConfigFn,
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

      expect(await createRunner(runnerParameters, metrics)).toEqual(config.shuffledAwsRegionInstances[0]);

      expect(mockEC2.runInstances).toHaveBeenCalledTimes(2);
      expect(mockEC2.runInstances).toBeCalledWith(
        createExpectedRunInstancesLinux(runnerParameters, 2, false, 'vpc-agdgaduwg113-11'),
      );
      expect(mockEC2.runInstances).toBeCalledWith(
        createExpectedRunInstancesLinux(runnerParameters, 4, false, 'vpc-agdgaduwg113-12'),
      );
      expect(runnerConfigFn).toBeCalledTimes(1);
      expect(runnerConfigFn).toBeCalledWith(config.shuffledAwsRegionInstances[0]);
    });

    it('succeed, 1nd subnet and 2nd region', async () => {
      for (let i = 0; i < 4; i++) {
        mockRunInstances.promise.mockClear().mockRejectedValueOnce(new Error('test error msg'));
      }
      mockRunInstances.promise.mockClear().mockResolvedValueOnce(runInstanceSuccess);

      const runnerParameters = {
        runnerConfig: runnerConfigFn,
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

      expect(await createRunner(runnerParameters, metrics)).toEqual(config.shuffledAwsRegionInstances[1]);

      expect(mockEC2.runInstances).toHaveBeenCalledTimes(5);
      expect(mockEC2.runInstances).toBeCalledWith(
        createExpectedRunInstancesLinux(runnerParameters, 2, false, 'vpc-agdgaduwg113-11'),
      );
      expect(mockEC2.runInstances).toBeCalledWith(
        createExpectedRunInstancesLinux(runnerParameters, 4, false, 'vpc-agdgaduwg113-12'),
      );
      expect(mockEC2.runInstances).toBeCalledWith(
        createExpectedRunInstancesLinux(runnerParameters, 3, false, 'vpc-agdgaduwg113-11'),
      );
      expect(mockEC2.runInstances).toBeCalledWith(
        createExpectedRunInstancesLinux(runnerParameters, 5, false, 'vpc-agdgaduwg113-12'),
      );
      expect(mockEC2.runInstances).toBeCalledWith(
        createExpectedRunInstancesLinux(
          runnerParameters,
          0,
          false,
          Config.Instance.shuffledVPCsForAwsRegion('us-west-1')[0],
        ),
      );
      expect(runnerConfigFn).toBeCalledTimes(1);
      expect(runnerConfigFn).toBeCalledWith(config.shuffledAwsRegionInstances[1]);
    });

    it('fails, everywere', async () => {
      for (let i = 0; i < 8; i++) {
        mockRunInstances.promise.mockClear().mockRejectedValueOnce(new Error('test error msg'));
      }

      const runnerParameters = {
        runnerConfig: runnerConfigFn,
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

      await expect(createRunner(runnerParameters, metrics)).rejects.toThrow();

      expect(mockEC2.runInstances).toHaveBeenCalledTimes(8);
      expect(runnerConfigFn).toBeCalledTimes(0);
    });
  });
});
