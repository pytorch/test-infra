import { listRunners, RunnerInfo, createRunner } from './runners';
import { EC2, SSM } from 'aws-sdk';

const mockEC2 = { describeInstances: jest.fn(), runInstances: jest.fn() };
const mockSSM = { putParameter: jest.fn() };
jest.mock('aws-sdk', () => ({
  EC2: jest.fn().mockImplementation(() => mockEC2),
  SSM: jest.fn().mockImplementation(() => mockSSM),
}));

describe('list instances', () => {
  const mockDescribeInstances = { promise: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
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

describe('create runner', () => {
  const mockRunInstances = { promise: jest.fn() };
  const mockPutParameter = { promise: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    mockEC2.runInstances.mockImplementation(() => mockRunInstances);
    mockRunInstances.promise.mockReturnValue({
      Instances: [
        {
          InstanceId: 'i-1234',
        },
      ],
    });
    mockSSM.putParameter.mockImplementation(() => mockPutParameter);
    process.env.LAUNCH_TEMPLATE_NAME = 'launch-template-name';
    process.env.LAUNCH_TEMPLATE_VERSION = '1';
    process.env.SUBNET_IDS = 'sub-1234';
  });

  it('calls run instances with the correct config for repo', async () => {
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
      },
    });
    expect(mockEC2.runInstances).toBeCalledWith({
      MaxCount: 1,
      MinCount: 1,
      LaunchTemplate: { LaunchTemplateName: 'launch-template-name', Version: '1' },
      SubnetId: 'sub-1234',
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Application', Value: 'github-action-runner' },
            { Key: 'Repo', Value: 'SomeAwesomeCoder/some-amazing-library' },
          ],
        },
      ],
    });
  });

  it('calls run instances with the correct config for org', async () => {
    await createRunner({
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
      },
    });
    expect(mockEC2.runInstances).toBeCalledWith({
      MaxCount: 1,
      MinCount: 1,
      LaunchTemplate: { LaunchTemplateName: 'launch-template-name', Version: '1' },
      SubnetId: 'sub-1234',
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Application', Value: 'github-action-runner' },
            { Key: 'Org', Value: 'SomeAwesomeCoder' },
          ],
        },
      ],
    });
  });

  it('creates ssm parameters for each created instance', async () => {
    await createRunner({
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
      repoName: undefined,
      orgName: 'SomeAwesomeCoder',
      runnerType: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
      },
    });
    expect(mockSSM.putParameter).not.toBeCalled();
  });
});
