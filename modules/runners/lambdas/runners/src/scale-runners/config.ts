export class Config {
  private static _instance: Config;

  readonly awsRegion: string;
  readonly environment: string;
  readonly ghesUrl: undefined | string;
  readonly githubAppClientId: string;
  readonly githubAppClientSecret: string;
  readonly githubAppId: string;
  readonly kmsKeyId: string;
  readonly launchTemplateNameLinux: string;
  readonly launchTemplateNameWindows: string;
  readonly launchTemplateVersionLinux: string;
  readonly launchTemplateVersionWindows: string;
  readonly minAvailableRunners: number;
  readonly minimumRunningTimeInMinutes: number;
  readonly runnerGroupName: string;
  readonly runnersExtraLabels: undefined | string;
  readonly secretsManagerSecretsId: string;
  readonly securityGroupIds: string[];
  readonly subnetIds: string[];

  protected constructor() {
    this.awsRegion = process.env.AWS_REGION as string;
    this.environment = process.env.ENVIRONMENT as string;
    /* istanbul ignore next */
    this.ghesUrl = process.env.GHES_URL as string;
    this.githubAppClientId = process.env.GITHUB_APP_CLIENT_ID as string;
    this.githubAppClientSecret = process.env.GITHUB_APP_CLIENT_SECRET as string;
    this.githubAppId = process.env.GITHUB_APP_ID as string;
    this.kmsKeyId = process.env.KMS_KEY_ID as string;
    this.launchTemplateNameLinux = process.env.LAUNCH_TEMPLATE_NAME_LINUX as string;
    this.launchTemplateNameWindows = process.env.LAUNCH_TEMPLATE_NAME_WINDOWS as string;
    this.launchTemplateVersionLinux = process.env.LAUNCH_TEMPLATE_VERSION_LINUX as string;
    this.launchTemplateVersionWindows = process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS as string;

    /* istanbul ignore next */
    const mnAvalRuns = Number(process.env.MIN_AVAILABLE_RUNNERS || '10');
    /* istanbul ignore next */
    this.minAvailableRunners = mnAvalRuns > 0 ? mnAvalRuns : 1;
    this.minimumRunningTimeInMinutes = Number(process.env.MINIMUM_RUNNING_TIME_IN_MINUTES);
    this.runnerGroupName = process.env.RUNNER_GROUP_NAME as string;
    this.runnersExtraLabels = process.env.RUNNER_EXTRA_LABELS as string;
    this.secretsManagerSecretsId = process.env.SECRETSMANAGER_SECRETS_ID as string;
    /* istanbul ignore next */
    this.securityGroupIds = (process.env.SECURITY_GROUP_IDS as string)?.split(',');
    /* istanbul ignore next */
    this.subnetIds = (process.env.SUBNET_IDS as string)?.split(',');
  }

  static get Instance(): Config {
    return this._instance || (this._instance = new this());
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
