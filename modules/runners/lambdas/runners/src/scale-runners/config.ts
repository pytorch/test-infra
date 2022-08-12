import { getBoolean } from './utils';

export class Config {
  private static _instance: Config | undefined;

  readonly awsRegion: string;
  readonly environment: string;
  readonly ghesUrl: undefined | string;
  readonly githubAppClientId: string | undefined;
  readonly githubAppClientSecret: string | undefined;
  readonly githubAppId: string | undefined;
  readonly kmsKeyId: string | undefined;
  readonly launchTemplateNameLinux: string | undefined;
  readonly launchTemplateNameWindows: string | undefined;
  readonly launchTemplateVersionLinux: string | undefined;
  readonly launchTemplateVersionWindows: string | undefined;
  readonly minAvailableRunners: number;
  readonly minimumRunningTimeInMinutes: number;
  readonly runnerGroupName: string | undefined;
  readonly runnersExtraLabels: undefined | string;
  readonly scaleConfigRepo: string;
  readonly scaleConfigRepoPath: string;
  readonly secretsManagerSecretsId: string | undefined;
  readonly securityGroupIds: string[];
  readonly subnetIds: string[];
  readonly enableOrganizationRunners: boolean;

  protected constructor() {
    this.awsRegion = process.env.AWS_REGION || 'us-east-1';
    this.environment = process.env.ENVIRONMENT || 'gh-ci';
    /* istanbul ignore next */
    this.ghesUrl = process.env.GHES_URL;
    this.githubAppClientId = process.env.GITHUB_APP_CLIENT_ID;
    this.githubAppClientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
    this.githubAppId = process.env.GITHUB_APP_ID;
    this.kmsKeyId = process.env.KMS_KEY_ID;
    this.launchTemplateNameLinux = process.env.LAUNCH_TEMPLATE_NAME_LINUX;
    this.launchTemplateNameWindows = process.env.LAUNCH_TEMPLATE_NAME_WINDOWS;
    this.launchTemplateVersionLinux = process.env.LAUNCH_TEMPLATE_VERSION_LINUX;
    this.launchTemplateVersionWindows = process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS;

    /* istanbul ignore next */
    const mnAvalRuns = Number(process.env.MIN_AVAILABLE_RUNNERS || '10');
    /* istanbul ignore next */
    this.minAvailableRunners = mnAvalRuns > 0 ? mnAvalRuns : 1;

    /* istanbul ignore next */
    const mnRunMin = Number(process.env.MINIMUM_RUNNING_TIME_IN_MINUTES || '10');
    /* istanbul ignore next */
    this.minimumRunningTimeInMinutes = mnRunMin > 0 ? mnRunMin : 1;
    this.runnerGroupName = process.env.RUNNER_GROUP_NAME;
    this.runnersExtraLabels = process.env.RUNNER_EXTRA_LABELS;
    /* istanbul ignore next */
    this.scaleConfigRepo = process.env.SCALE_CONFIG_REPO || 'test-infra';
    this.scaleConfigRepoPath = process.env.SCALE_CONFIG_REPO_PATH || '.github/scale-config.yml';
    this.secretsManagerSecretsId = process.env.SECRETSMANAGER_SECRETS_ID;
    /* istanbul ignore next */
    this.securityGroupIds = process.env.SECURITY_GROUP_IDS?.split(',') ?? [];
    /* istanbul ignore next */
    this.subnetIds = process.env.SUBNET_IDS?.split(',') ?? [];
    this.enableOrganizationRunners = getBoolean(process.env.ENABLE_ORGANIZATION_RUNNERS);
  }

  static get Instance(): Config {
    return this._instance || (this._instance = new this());
  }

  static resetConfig() {
    this._instance = undefined;
  }

  get shuffledSubnetIds(): string[] {
    const shuffled = [...this.subnetIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  get ghesUrlApi(): undefined | string {
    /* istanbul ignore next */
    return this.ghesUrl?.concat('/api/v3');
  }

  get ghesUrlHost(): string {
    /* istanbul ignore next */
    return this.ghesUrl ?? 'https://github.com';
  }
}
