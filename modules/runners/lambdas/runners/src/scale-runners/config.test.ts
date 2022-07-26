import { Config } from './config';
import nock from 'nock';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  nock.disableNetConnect();
});

describe('Config', () => {
  it('if will correctly get setup from process.env', () => {
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
    process.env.MIN_AVAILABLE_RUNNERS = '113';
    process.env.MINIMUM_RUNNING_TIME_IN_MINUTES = '33';
    process.env.RUNNER_GROUP_NAME = 'RUNNER_GROUP_NAME';
    process.env.RUNNER_EXTRA_LABELS = 'RUNNER_EXTRA_LABELS';
    process.env.SECRETSMANAGER_SECRETS_ID = 'SECRETSMANAGER_SECRETS_ID';
    process.env.SECURITY_GROUP_IDS = 'SECURITY_GROUP_IDS1,SECURITY_GROUP_IDS2,SECURITY_GROUP_IDS3';
    process.env.SUBNET_IDS = 'SUBNET_IDS1,SUBNET_IDS2,SUBNET_IDS3';

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
    expect(Config.Instance.minAvailableRunners).toBe(113);
    expect(Config.Instance.minimumRunningTimeInMinutes).toBe(33);
    expect(Config.Instance.runnerGroupName).toBe('RUNNER_GROUP_NAME');
    expect(Config.Instance.runnersExtraLabels).toBe('RUNNER_EXTRA_LABELS');
    expect(Config.Instance.secretsManagerSecretsId).toBe('SECRETSMANAGER_SECRETS_ID');
    expect(Config.Instance.securityGroupIds).toEqual([
      'SECURITY_GROUP_IDS1',
      'SECURITY_GROUP_IDS2',
      'SECURITY_GROUP_IDS3',
    ]);
    expect(Config.Instance.subnetIds).toEqual(['SUBNET_IDS1', 'SUBNET_IDS2', 'SUBNET_IDS3']);

    expect(Config.Instance.shuffledSubnetIds).toContain('SUBNET_IDS1');
    expect(Config.Instance.shuffledSubnetIds).toContain('SUBNET_IDS2');
    expect(Config.Instance.shuffledSubnetIds).toContain('SUBNET_IDS3');
  });
});
