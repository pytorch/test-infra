import { Config } from './config';
import nock from 'nock';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

describe('Config', () => {
  it('if will correctly get setup from process.env', () => {
    Config.resetConfig();

    process.env.AWS_REGION = 'AWS_REGION';
    process.env.AWS_REGIONS_TO_VPC_IDS =
      'AWS_REGION|VPC_1,AWS_REGION|VPC_2,AWS_REGION_INSTANCES_1|VPC_3,' +
      'AWS_REGION_INSTANCES_2|VPC_4,AWS_REGION_INSTANCES_2|VPC_5';
    process.env.CANT_HAVE_ISSUES_LABELS = 'label 1,label 2';
    process.env.DATETIME_DEPLOY = '19050202000000';
    process.env.ENABLE_ORGANIZATION_RUNNERS = 'YES';
    process.env.ENVIRONMENT = 'ENVIRONMENT';
    process.env.GHES_URL = 'GHES_URL';
    process.env.GITHUB_APP_CLIENT_ID = 'GITHUB_APP_CLIENT_ID';
    process.env.GITHUB_APP_CLIENT_SECRET = 'GITHUB_APP_CLIENT_SECRET';
    process.env.GITHUB_APP_ID = 'GITHUB_APP_ID';
    process.env.KMS_KEY_ID = 'KMS_KEY_ID';
    process.env.LAMBDA_TIMEOUT = '113';
    process.env.LAUNCH_TEMPLATE_NAME_LINUX = 'LAUNCH_TEMPLATE_NAME_LINUX';
    process.env.LAUNCH_TEMPLATE_NAME_LINUX_NVIDIA = 'LAUNCH_TEMPLATE_NAME_LINUX_NVIDIA';
    process.env.LAUNCH_TEMPLATE_NAME_WINDOWS = 'LAUNCH_TEMPLATE_NAME_WINDOWS';
    process.env.LAUNCH_TEMPLATE_VERSION_LINUX = 'LAUNCH_TEMPLATE_VERSION_LINUX';
    process.env.LAUNCH_TEMPLATE_VERSION_LINUX_NVIDIA = 'LAUNCH_TEMPLATE_VERSION_LINUX_NVIDIA';
    process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS = 'LAUNCH_TEMPLATE_VERSION_WINDOWS';
    process.env.MINIMUM_RUNNING_TIME_IN_MINUTES = '33';
    process.env.MIN_AVAILABLE_RUNNERS = '113';
    process.env.MUST_HAVE_ISSUES_LABELS = 'label 1,label 2';
    process.env.RUNNER_EXTRA_LABELS = 'RUNNER_EXTRA_LABELS';
    process.env.RUNNER_GROUP_NAME = 'RUNNER_GROUP_NAME';
    process.env.SCALE_CONFIG_REPO = 'SCALE_CONFIG_REPO';
    process.env.SCALE_CONFIG_REPO_PATH = '.gh/the.yaml';
    process.env.SECRETSMANAGER_SECRETS_ID = 'SECRETSMANAGER_SECRETS_ID';
    process.env.VPC_ID_TO_SECURITY_GROUP_IDS =
      'VPC_1|SG_1,VPC_1|SG_2,VPC_2|SG_3,VPC_2|SG_4,VPC_3|SG_5,VPC_4|SG_6,VPC_5|SG_7';
    process.env.VPC_ID_TO_SUBNET_IDS = 'VPC_1|SN_1,VPC_1|SN_2,VPC_2|SN_3,VPC_2|SN_4,VPC_3|SN_5,VPC_4|SN_6,VPC_5|SN_7';
    process.env.SUBNET_ID_TO_AZ = 'SN_1|AZ_1,SN_2|AZ_2,SN_3|AZ_1,SN_4|AZ_2,SN_5|AZ_1,SN_6|AZ_2';

    expect(Config.Instance.awsRegion).toBe('AWS_REGION');
    expect(Config.Instance.awsRegionsToVpcIds).toEqual(
      new Map([
        ['AWS_REGION', ['VPC_1', 'VPC_2']],
        ['AWS_REGION_INSTANCES_1', ['VPC_3']],
        ['AWS_REGION_INSTANCES_2', ['VPC_4', 'VPC_5']],
      ]),
    );
    expect(Config.Instance.cantHaveIssuesLabels).toEqual(['label 1', 'label 2']);
    expect(Config.Instance.datetimeDeploy).toBe('19050202000000');
    expect(Config.Instance.environment).toBe('ENVIRONMENT');
    expect(Config.Instance.ghesUrl).toBe('GHES_URL');
    expect(Config.Instance.ghesUrlApi).toBe('GHES_URL/api/v3');
    expect(Config.Instance.ghesUrlHost).toBe('GHES_URL');
    expect(Config.Instance.githubAppClientId).toBe('GITHUB_APP_CLIENT_ID');
    expect(Config.Instance.githubAppClientSecret).toBe('GITHUB_APP_CLIENT_SECRET');
    expect(Config.Instance.githubAppId).toBe('GITHUB_APP_ID');
    expect(Config.Instance.kmsKeyId).toBe('KMS_KEY_ID');
    expect(Config.Instance.lambdaTimeout).toBe(113);
    expect(Config.Instance.launchTemplateNameLinux).toBe('LAUNCH_TEMPLATE_NAME_LINUX');
    expect(Config.Instance.launchTemplateNameLinuxNvidia).toBe('LAUNCH_TEMPLATE_NAME_LINUX_NVIDIA');
    expect(Config.Instance.launchTemplateNameWindows).toBe('LAUNCH_TEMPLATE_NAME_WINDOWS');
    expect(Config.Instance.launchTemplateVersionLinux).toBe('LAUNCH_TEMPLATE_VERSION_LINUX');
    expect(Config.Instance.launchTemplateVersionLinuxNvidia).toBe('LAUNCH_TEMPLATE_VERSION_LINUX_NVIDIA');
    expect(Config.Instance.launchTemplateVersionWindows).toBe('LAUNCH_TEMPLATE_VERSION_WINDOWS');
    expect(Config.Instance.minAvailableRunners).toBe(113);
    expect(Config.Instance.minimumRunningTimeInMinutes).toBe(33);
    expect(Config.Instance.mustHaveIssuesLabels).toEqual(['label 1', 'label 2']);
    expect(Config.Instance.runnerGroupName).toEqual('RUNNER_GROUP_NAME');
    expect(Config.Instance.runnersExtraLabels).toBe('RUNNER_EXTRA_LABELS');
    expect(Config.Instance.scaleConfigRepo).toEqual('SCALE_CONFIG_REPO');
    expect(Config.Instance.scaleConfigRepoPath).toEqual('.gh/the.yaml');
    expect(Config.Instance.secretsManagerSecretsId).toBe('SECRETSMANAGER_SECRETS_ID');
    expect(Config.Instance.vpcIdToSecurityGroupIds).toEqual(
      new Map([
        ['VPC_1', ['SG_1', 'SG_2']],
        ['VPC_2', ['SG_3', 'SG_4']],
        ['VPC_3', ['SG_5']],
        ['VPC_4', ['SG_6']],
        ['VPC_5', ['SG_7']],
      ]),
    );
    expect(Config.Instance.vpcIdToSubnetIds).toEqual(
      new Map([
        ['VPC_1', ['SN_1', 'SN_2']],
        ['VPC_2', ['SN_3', 'SN_4']],
        ['VPC_3', ['SN_5']],
        ['VPC_4', ['SN_6']],
        ['VPC_5', ['SN_7']],
      ]),
    );
    expect(Config.Instance.subnetIdToVpcId).toEqual(
      new Map([
        ['SN_1', 'VPC_1'],
        ['SN_2', 'VPC_1'],
        ['SN_3', 'VPC_2'],
        ['SN_4', 'VPC_2'],
        ['SN_5', 'VPC_3'],
        ['SN_6', 'VPC_4'],
        ['SN_7', 'VPC_5'],
      ]),
    );
    expect(Config.Instance.subnetIdToAZ).toEqual(
      new Map([
        ['SN_1', 'AZ_1'],
        ['SN_2', 'AZ_2'],
        ['SN_3', 'AZ_1'],
        ['SN_4', 'AZ_2'],
        ['SN_5', 'AZ_1'],
        ['SN_6', 'AZ_2'],
      ]),
    );
    expect(Config.Instance.azToSubnetIds).toEqual(
      new Map([
        ['AZ_1', ['SN_1', 'SN_3', 'SN_5']],
        ['AZ_2', ['SN_2', 'SN_4', 'SN_6']],
      ]),
    );

    expect(Config.Instance.shuffledAwsRegionInstances.length).toEqual(3);
    expect(Config.Instance.shuffledAwsRegionInstances).toContain('AWS_REGION');
    expect(Config.Instance.shuffledAwsRegionInstances).toContain('AWS_REGION_INSTANCES_2');
    expect(Config.Instance.shuffledAwsRegionInstances).toContain('AWS_REGION_INSTANCES_1');
    expect(Config.Instance.enableOrganizationRunners).toBeTruthy();
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION').length).toEqual(2);
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION')).toContainEqual('VPC_1');
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION')).toContainEqual('VPC_2');
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION_INSTANCES_1').length).toEqual(1);
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION_INSTANCES_1')).toContainEqual('VPC_3');
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION_INSTANCES_2').length).toEqual(2);
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION_INSTANCES_2')).toContainEqual('VPC_4');
    expect(Config.Instance.shuffledVPCsForAwsRegion('AWS_REGION_INSTANCES_2')).toContainEqual('VPC_5');
  });

  it('check defaults', () => {
    Config.resetConfig();

    delete process.env.AWS_REGION;
    delete process.env.AWS_REGIONS_TO_VPC_IDS;
    delete process.env.CANT_HAVE_ISSUES_LABELS;
    delete process.env.DATETIME_DEPLOY;
    delete process.env.ENVIRONMENT;
    delete process.env.GHES_URL;
    delete process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    delete process.env.GITHUB_APP_ID;
    delete process.env.KMS_KEY_ID;
    delete process.env.LAMBDA_TIMEOUT;
    process.env.LAUNCH_TEMPLATE_NAME_LINUX = 'LAUNCH_TEMPLATE_NAME_LINUX';
    process.env.LAUNCH_TEMPLATE_NAME_LINUX_NVIDIA = 'LAUNCH_TEMPLATE_NAME_LINUX_NVIDIA';
    process.env.LAUNCH_TEMPLATE_NAME_WINDOWS = 'LAUNCH_TEMPLATE_NAME_WINDOWS';
    process.env.LAUNCH_TEMPLATE_VERSION_LINUX = 'LAUNCH_TEMPLATE_VERSION_LINUX';
    process.env.LAUNCH_TEMPLATE_VERSION_LINUX_NVIDIA = 'LAUNCH_TEMPLATE_VERSION_LINUX_NVIDIA';
    process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS = 'LAUNCH_TEMPLATE_VERSION_WINDOWS';
    delete process.env.MIN_AVAILABLE_RUNNERS;
    delete process.env.MUST_HAVE_ISSUES_LABELS;
    delete process.env.MINIMUM_RUNNING_TIME_IN_MINUTES;
    delete process.env.RUNNER_EXTRA_LABELS;
    delete process.env.RUNNER_GROUP_NAME;
    delete process.env.SCALE_CONFIG_REPO;
    delete process.env.SCALE_CONFIG_REPO_PATH;
    delete process.env.SECRETSMANAGER_SECRETS_ID;
    delete process.env.VPC_ID_TO_SECURITY_GROUP_IDS;
    delete process.env.ENABLE_ORGANIZATION_RUNNERS;

    expect(Config.Instance.awsRegion).toBe('us-east-1');
    expect(Config.Instance.cantHaveIssuesLabels).toEqual([]);
    expect(Config.Instance.datetimeDeploy).toBeUndefined();
    expect(Config.Instance.environment).toBe('gh-ci');
    expect(Config.Instance.ghesUrl).toBeUndefined();
    expect(Config.Instance.ghesUrlApi).toBeUndefined();
    expect(Config.Instance.ghesUrlHost).toBe('https://github.com');
    expect(Config.Instance.githubAppClientId).toBeUndefined();
    expect(Config.Instance.githubAppClientSecret).toBeUndefined();
    expect(Config.Instance.githubAppId).toBeUndefined();
    expect(Config.Instance.kmsKeyId).toBeUndefined();
    expect(Config.Instance.lambdaTimeout).toEqual(600);
    expect(Config.Instance.launchTemplateNameLinux).toBe('LAUNCH_TEMPLATE_NAME_LINUX');
    expect(Config.Instance.launchTemplateNameLinuxNvidia).toBe('LAUNCH_TEMPLATE_NAME_LINUX_NVIDIA');
    expect(Config.Instance.launchTemplateNameWindows).toBe('LAUNCH_TEMPLATE_NAME_WINDOWS');
    expect(Config.Instance.launchTemplateVersionLinux).toBe('LAUNCH_TEMPLATE_VERSION_LINUX');
    expect(Config.Instance.launchTemplateVersionLinuxNvidia).toBe('LAUNCH_TEMPLATE_VERSION_LINUX_NVIDIA');
    expect(Config.Instance.launchTemplateVersionWindows).toBe('LAUNCH_TEMPLATE_VERSION_WINDOWS');
    expect(Config.Instance.minAvailableRunners).toBe(10);
    expect(Config.Instance.minimumRunningTimeInMinutes).toBe(10);
    expect(Config.Instance.mustHaveIssuesLabels).toEqual([]);
    expect(Config.Instance.runnerGroupName).toBeUndefined();
    expect(Config.Instance.runnersExtraLabels).toBeUndefined();
    expect(Config.Instance.scaleConfigRepo).toEqual('test-infra');
    expect(Config.Instance.scaleConfigRepoPath).toEqual('.github/scale-config.yml');
    expect(Config.Instance.secretsManagerSecretsId).toBeUndefined();
    expect(Config.Instance.shuffledAwsRegionInstances).toEqual([]);
    expect(Config.Instance.enableOrganizationRunners).toBeFalsy();
  });
});
