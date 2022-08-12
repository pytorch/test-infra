import { Config } from './config';
import nock from 'nock';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  nock.disableNetConnect();
});

describe('Config', () => {
  it('if will correctly get setup from process.env', () => {
    Config.resetConfig();

    process.env.AWS_REGION = 'AWS_REGION';
    process.env.ENVIRONMENT = 'ENVIRONMENT';
    process.env.GHES_URL = 'GHES_URL';
    process.env.GITHUB_APP_CLIENT_ID = 'GITHUB_APP_CLIENT_ID';
    process.env.GITHUB_APP_CLIENT_SECRET = 'GITHUB_APP_CLIENT_SECRET';
    process.env.GITHUB_APP_ID = 'GITHUB_APP_ID';
    process.env.KMS_KEY_ID = 'KMS_KEY_ID';
    process.env.LAUNCH_TEMPLATE_NAME_LINUX = 'LAUNCH_TEMPLATE_NAME_LINUX';
    process.env.LAUNCH_TEMPLATE_NAME_WINDOWS = 'LAUNCH_TEMPLATE_NAME_WINDOWS';
    process.env.LAUNCH_TEMPLATE_VERSION_LINUX = 'LAUNCH_TEMPLATE_VERSION_LINUX';
    process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS = 'LAUNCH_TEMPLATE_VERSION_WINDOWS';
    process.env.MINIMUM_RUNNING_TIME_IN_MINUTES = '33';
    process.env.MIN_AVAILABLE_RUNNERS = '113';
    process.env.RUNNER_EXTRA_LABELS = 'RUNNER_EXTRA_LABELS';
    process.env.RUNNER_GROUP_NAME = 'RUNNER_GROUP_NAME';
    process.env.SCALE_CONFIG_REPO = 'SCALE_CONFIG_REPO';
    process.env.SCALE_CONFIG_REPO_PATH = '.gh/the.yaml';
    process.env.SECRETSMANAGER_SECRETS_ID = 'SECRETSMANAGER_SECRETS_ID';
    process.env.SECURITY_GROUP_IDS = 'SECURITY_GROUP_IDS1,SECURITY_GROUP_IDS2,SECURITY_GROUP_IDS3';
    process.env.SUBNET_IDS = 'SUBNET_IDS1,SUBNET_IDS2,SUBNET_IDS3';
    process.env.ENABLE_ORGANIZATION_RUNNERS = 'YES';

    expect(Config.Instance.awsRegion).toBe('AWS_REGION');
    expect(Config.Instance.environment).toBe('ENVIRONMENT');
    expect(Config.Instance.ghesUrl).toBe('GHES_URL');
    expect(Config.Instance.ghesUrlApi).toBe('GHES_URL/api/v3');
    expect(Config.Instance.ghesUrlHost).toBe('GHES_URL');
    expect(Config.Instance.githubAppClientId).toBe('GITHUB_APP_CLIENT_ID');
    expect(Config.Instance.githubAppClientSecret).toBe('GITHUB_APP_CLIENT_SECRET');
    expect(Config.Instance.githubAppId).toBe('GITHUB_APP_ID');
    expect(Config.Instance.kmsKeyId).toBe('KMS_KEY_ID');
    expect(Config.Instance.launchTemplateNameLinux).toBe('LAUNCH_TEMPLATE_NAME_LINUX');
    expect(Config.Instance.launchTemplateNameWindows).toBe('LAUNCH_TEMPLATE_NAME_WINDOWS');
    expect(Config.Instance.launchTemplateVersionLinux).toBe('LAUNCH_TEMPLATE_VERSION_LINUX');
    expect(Config.Instance.launchTemplateVersionWindows).toBe('LAUNCH_TEMPLATE_VERSION_WINDOWS');
    expect(Config.Instance.minAvailableRunners).toBe(113);
    expect(Config.Instance.minimumRunningTimeInMinutes).toBe(33);
    expect(Config.Instance.runnerGroupName).toEqual('RUNNER_GROUP_NAME');
    expect(Config.Instance.runnersExtraLabels).toBe('RUNNER_EXTRA_LABELS');
    expect(Config.Instance.scaleConfigRepo).toEqual('SCALE_CONFIG_REPO');
    expect(Config.Instance.scaleConfigRepoPath).toEqual('.gh/the.yaml');
    expect(Config.Instance.secretsManagerSecretsId).toBe('SECRETSMANAGER_SECRETS_ID');
    expect(Config.Instance.securityGroupIds).toEqual([
      'SECURITY_GROUP_IDS1',
      'SECURITY_GROUP_IDS2',
      'SECURITY_GROUP_IDS3',
    ]);
    expect(Config.Instance.shuffledSubnetIds).toContain('SUBNET_IDS1');
    expect(Config.Instance.shuffledSubnetIds).toContain('SUBNET_IDS2');
    expect(Config.Instance.shuffledSubnetIds).toContain('SUBNET_IDS3');
    expect(Config.Instance.subnetIds).toEqual(['SUBNET_IDS1', 'SUBNET_IDS2', 'SUBNET_IDS3']);
    expect(Config.Instance.enableOrganizationRunners).toBeTruthy();
  });

  it('check defaults', () => {
    Config.resetConfig();

    delete process.env.AWS_REGION;
    delete process.env.ENVIRONMENT;
    delete process.env.GHES_URL;
    delete process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    delete process.env.GITHUB_APP_ID;
    delete process.env.KMS_KEY_ID;
    process.env.LAUNCH_TEMPLATE_NAME_LINUX = 'LAUNCH_TEMPLATE_NAME_LINUX';
    process.env.LAUNCH_TEMPLATE_NAME_WINDOWS = 'LAUNCH_TEMPLATE_NAME_WINDOWS';
    process.env.LAUNCH_TEMPLATE_VERSION_LINUX = 'LAUNCH_TEMPLATE_VERSION_LINUX';
    process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS = 'LAUNCH_TEMPLATE_VERSION_WINDOWS';
    delete process.env.MIN_AVAILABLE_RUNNERS;
    delete process.env.MINIMUM_RUNNING_TIME_IN_MINUTES;
    delete process.env.RUNNER_EXTRA_LABELS;
    delete process.env.RUNNER_GROUP_NAME;
    delete process.env.SCALE_CONFIG_REPO;
    delete process.env.SCALE_CONFIG_REPO_PATH;
    delete process.env.SECRETSMANAGER_SECRETS_ID;
    delete process.env.SECURITY_GROUP_IDS;
    delete process.env.SUBNET_IDS;
    delete process.env.ENABLE_ORGANIZATION_RUNNERS;

    expect(Config.Instance.awsRegion).toBe('us-east-1');
    expect(Config.Instance.environment).toBe('gh-ci');
    expect(Config.Instance.ghesUrl).toBeUndefined();
    expect(Config.Instance.ghesUrlApi).toBeUndefined();
    expect(Config.Instance.ghesUrlHost).toBe('https://github.com');
    expect(Config.Instance.githubAppClientId).toBeUndefined();
    expect(Config.Instance.githubAppClientSecret).toBeUndefined();
    expect(Config.Instance.githubAppId).toBeUndefined();
    expect(Config.Instance.kmsKeyId).toBeUndefined();
    expect(Config.Instance.launchTemplateNameLinux).toBe('LAUNCH_TEMPLATE_NAME_LINUX');
    expect(Config.Instance.launchTemplateNameWindows).toBe('LAUNCH_TEMPLATE_NAME_WINDOWS');
    expect(Config.Instance.launchTemplateVersionLinux).toBe('LAUNCH_TEMPLATE_VERSION_LINUX');
    expect(Config.Instance.launchTemplateVersionWindows).toBe('LAUNCH_TEMPLATE_VERSION_WINDOWS');
    expect(Config.Instance.minAvailableRunners).toBe(10);
    expect(Config.Instance.minimumRunningTimeInMinutes).toBe(10);
    expect(Config.Instance.runnerGroupName).toBeUndefined();
    expect(Config.Instance.runnersExtraLabels).toBeUndefined();
    expect(Config.Instance.scaleConfigRepo).toEqual('test-infra');
    expect(Config.Instance.scaleConfigRepoPath).toEqual('.github/scale-config.yml');
    expect(Config.Instance.secretsManagerSecretsId).toBeUndefined();
    expect(Config.Instance.securityGroupIds.length).toEqual(0);
    expect(Config.Instance.shuffledSubnetIds.length).toEqual(0);
    expect(Config.Instance.subnetIds.length).toEqual(0);
    expect(Config.Instance.enableOrganizationRunners).toBeFalsy();
  });
});
