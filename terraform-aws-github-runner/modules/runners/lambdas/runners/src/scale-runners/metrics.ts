import { CloudWatch } from 'aws-sdk';
import { Config } from './config';
import { expBackOff, Repo, RunnerInfo, getRepo } from './utils';

interface CloudWatchMetricReq {
  MetricData: Array<CloudWatchMetric>;
  Namespace: string;
}

interface CloudWatchMetric {
  Counts: Array<number>;
  MetricName: string;
  Timestamp: Date;
  Unit: string;
  Values: Array<number>;
}

export class Metrics {
  protected cloudwatch: CloudWatch;
  protected lambda: string;
  protected metrics: Map<string, Map<number, number>>;

  protected static baseMetricTypes = new Map<string, string>();

  /* istanbul ignore next */
  protected getMetricType(metric: string): string {
    if (Metrics.baseMetricTypes.has(metric)) return Metrics.baseMetricTypes.get(metric) as string;
    if (metric.endsWith('.wallclock')) return 'Milliseconds';
    if (metric.endsWith('.runningWallclock')) return 'Seconds';
    return 'Count';
  }

  protected countEntry(key: string, inc = 1) {
    if (this.metrics.has(key)) {
      const mx = Math.max(...(this.metrics.get(key) as Map<number, number>).keys());
      this.metrics.set(key, new Map([[mx + inc, 1]]));
    } else {
      this.metrics.set(key, new Map([[inc, 1]]));
    }
  }

  protected addEntry(key: string, value: number) {
    const entry = (this.metrics.has(key) ? this.metrics : this.metrics.set(key, new Map())).get(key) as Map<
      number,
      number
    >;

    if (entry.has(value)) {
      entry.set(value, (entry.get(value) as number) + 1);
    } else {
      entry.set(value, 1);
    }
  }

  protected constructor(lambda: string) {
    this.cloudwatch = new CloudWatch({ region: Config.Instance.awsRegion });
    this.lambda = lambda;
    this.metrics = new Map();
  }

  msTimer() {
    const start = Date.now();
    return () => {
      return Date.now() - start;
    };
  }

  async trackRequest<T>(
    regSuccess: (tm: number) => void,
    regFail: (rm: number) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timer = this.msTimer();
    try {
      const r = await fn();
      regSuccess.call(this, timer());
      return r;
    } catch (e) {
      regFail.call(this, timer());
      throw e;
    }
  }

  async sendMetrics() {
    if (this.metrics.size < 1) {
      return;
    }

    const timestamp = new Date();
    let metricsReqCounts = 25;
    const awsMetrics = new Array<CloudWatchMetricReq>();

    this.metrics.forEach((vals, name) => {
      let metricUnitCounts = 100;

      vals.forEach((count, val) => {
        if (metricsReqCounts >= 25) {
          metricsReqCounts = 0;
          metricUnitCounts = 100;
          awsMetrics.push({
            MetricData: new Array<CloudWatchMetric>(),
            Namespace: `${Config.Instance.environment}-${this.lambda}`,
          });
        }
        metricsReqCounts += 1;

        if (metricUnitCounts >= 100) {
          metricUnitCounts = 0;
          awsMetrics[awsMetrics.length - 1].MetricData.push({
            Counts: [],
            MetricName: name,
            Timestamp: timestamp,
            Unit: this.getMetricType(name),
            Values: [],
          });
        }
        metricUnitCounts += 1;

        const md = awsMetrics[awsMetrics.length - 1].MetricData;
        md[md.length - 1].Counts.push(count);
        md[md.length - 1].Values.push(val);
      });
    });

    for (const metricsReq of awsMetrics.values()) {
      await expBackOff(() => {
        return this.cloudwatch.putMetricData(metricsReq).promise();
      });
    }
  }

  // GitHub API CALLS
  /* istanbul ignore next */
  createAppAuthGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createAppAuth.count`, 1);
    this.countEntry(`gh.calls.createAppAuth.success`, 1);
    this.addEntry(`gh.calls.createAppAuth.wallclock`, ms);
  }

  /* istanbul ignore next */
  createAppAuthGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createAppAuth.count`, 1);
    this.countEntry(`gh.calls.createAppAuth.failure`, 1);
    this.addEntry(`gh.calls.createAppAuth.wallclock`, ms);
  }

  /* istanbul ignore next */
  issuesAndPullRequestsGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.count`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.success`, 1);
    this.addEntry(`gh.calls.issuesAndPullRequests.wallclock`, ms);
  }

  /* istanbul ignore next */
  issuesAndPullRequestsGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.count`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.failure`, 1);
    this.addEntry(`gh.calls.issuesAndPullRequests.wallclock`, ms);
  }

  /* istanbul ignore next */
  getRepoInstallationGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.count`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.success`, 1);
    this.addEntry(`gh.calls.getRepoInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  getRepoInstallationGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.count`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.failure`, 1);
    this.addEntry(`gh.calls.getRepoInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  getOrgInstallationGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.count`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.success`, 1);
    this.addEntry(`gh.calls.getOrgInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  getOrgInstallationGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.count`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.failure`, 1);
    this.addEntry(`gh.calls.getOrgInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.success`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.failure`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.success`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.failure`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.success`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.failure`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.success`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.failure`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.success`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.failure`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.success`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.failure`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  reposGetContentGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.reposGetContent.count`, 1);
    this.countEntry(`gh.calls.reposGetContent.success`, 1);
    this.addEntry(`gh.calls.reposGetContent.wallclock`, ms);
  }

  /* istanbul ignore next */
  reposGetContentGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.reposGetContent.count`, 1);
    this.countEntry(`gh.calls.reposGetContent.failure`, 1);
    this.addEntry(`gh.calls.reposGetContent.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.success`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.failure`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.success`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.failure`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForOrg.wallclock`, ms);
  }

  // AWS API CALLS
  /* istanbul ignore next */
  kmsDecryptAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.kms.calls.total`, 1);
    this.countEntry(`aws.kms.decrypt.count`, 1);
    this.countEntry(`aws.kms.decrypt.success`, 1);
    this.addEntry(`aws.kms.decrypt.wallclock`, ms);
  }

  /* istanbul ignore next */
  kmsDecryptAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.kms.calls.total`, 1);
    this.countEntry(`aws.kms.decrypt.count`, 1);
    this.countEntry(`aws.kms.decrypt.failure`, 1);
    this.addEntry(`aws.kms.decrypt.wallclock`, ms);
  }

  /* istanbul ignore next */
  smGetSecretValueAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.sm.calls.total`, 1);
    this.countEntry(`aws.sm.getSecretValue.count`, 1);
    this.countEntry(`aws.sm.getSecretValue.success`, 1);
    this.addEntry(`aws.sm.getSecretValue.wallclock`, ms);
  }

  /* istanbul ignore next */
  smGetSecretValueAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.sm.calls.total`, 1);
    this.countEntry(`aws.sm.getSecretValue.count`, 1);
    this.countEntry(`aws.sm.getSecretValue.failure`, 1);
    this.addEntry(`aws.sm.getSecretValue.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmPutParameterAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.putParameter.count`, 1);
    this.countEntry(`aws.ssm.putParameter.success`, 1);
    this.addEntry(`aws.ssm.putParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmPutParameterAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.putParameter.count`, 1);
    this.countEntry(`aws.ssm.putParameter.failure`, 1);
    this.addEntry(`aws.ssm.putParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmdeleteParameterAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.deleteParameter.count`, 1);
    this.countEntry(`aws.ssm.deleteParameter.success`, 1);
    this.addEntry(`aws.ssm.deleteParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmdeleteParameterAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.deleteParameter.count`, 1);
    this.countEntry(`aws.ssm.deleteParameter.failure`, 1);
    this.addEntry(`aws.ssm.deleteParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2DescribeInstancesAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.describeInstances.count`, 1);
    this.countEntry(`aws.ec2.describeInstances.success`, 1);
    this.addEntry(`aws.ec2.describeInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2DescribeInstancesAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.describeInstances.count`, 1);
    this.countEntry(`aws.ec2.describeInstances.failure`, 1);
    this.addEntry(`aws.ec2.describeInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2TerminateInstancesAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.terminateInstances.count`, 1);
    this.countEntry(`aws.ec2.terminateInstances.success`, 1);
    this.addEntry(`aws.ec2.terminateInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2TerminateInstancesAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.terminateInstances.count`, 1);
    this.countEntry(`aws.ec2.terminateInstances.failure`, 1);
    this.addEntry(`aws.ec2.terminateInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2RunInstancesAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.runInstances.count`, 1);
    this.countEntry(`aws.ec2.runInstances.success`, 1);
    this.addEntry(`aws.ec2.runInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2RunInstancesAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.runInstances.count`, 1);
    this.countEntry(`aws.ec2.runInstances.failure`, 1);
    this.addEntry(`aws.ec2.runInstances.wallclock`, ms);
  }

  // RUN
  /* istanbul ignore next */
  getRunnerTypesSuccess() {
    this.countEntry(`run.getRunnerTypes.success`, 1);
  }

  /* istanbul ignore next */
  getRunnerTypesFailure() {
    this.countEntry(`run.getRunnerTypes.failure`, 1);
  }
}

export class ScaleUpMetrics extends Metrics {
  constructor() {
    super('scaleUp');
  }

  /* istanbul ignore next */
  runRepo(repo: Repo) {
    this.countEntry(`run.${repo.owner}.${repo.repo}.process`);
  }

  /* istanbul ignore next */
  skipRepo(repo: Repo) {
    this.countEntry(`run.${repo.owner}.${repo.repo}.skip`);
  }

  /* istanbul ignore next */
  ghRunnersRepoStats(repo: Repo, runnerType: string, total: number, labeled: number, busy: number) {
    this.addEntry(`run.${repo.owner}.${repo.repo}.ghrunners.total`, total);
    this.addEntry(`run.${repo.owner}.${repo.repo}.ghrunners.${runnerType}.total`, labeled);
    this.addEntry(`run.${repo.owner}.${repo.repo}.ghrunners.${runnerType}.busy`, busy);
    this.addEntry(`run.${repo.owner}.${repo.repo}.ghrunners.${runnerType}.available`, labeled - busy);
  }

  /* istanbul ignore next */
  ghRunnersOrgStats(org: string, runnerType: string, total: number, labeled: number, busy: number) {
    this.addEntry(`run.${org}.ghrunners.total`, total);
    this.addEntry(`run.${org}.ghrunners.${runnerType}.total`, labeled);
    this.addEntry(`run.${org}.ghrunners.${runnerType}.busy`, busy);
    this.addEntry(`run.${org}.ghrunners.${runnerType}.available`, labeled - busy);
  }

  /* istanbul ignore next */
  ghRunnersRepoMaxHit(repo: Repo, runnerType: string) {
    this.countEntry(`run.${repo.owner}.${repo.repo}.ghrunners.maxHit`);
    this.countEntry(`run.${repo.owner}.${repo.repo}.ghrunners.${runnerType}.maxHit`);
  }

  /* istanbul ignore next */
  ghRunnersOrgMaxHit(org: string, runnerType: string) {
    this.countEntry(`run.${org}.ghrunners.maxHit`);
    this.countEntry(`run.${org}.ghrunners.${runnerType}.maxHit`);
  }

  /* istanbul ignore next */
  runnersRepoCreate(repo: Repo, runnerType: string) {
    this.countEntry(`run.${repo.owner}.${repo.repo}.create.success.total`);
    this.countEntry(`run.${repo.owner}.${repo.repo}.create.success.${runnerType}`);
  }

  /* istanbul ignore next */
  runnersOrgCreate(org: string, runnerType: string) {
    this.countEntry(`run.${org}.create.success.total`);
    this.countEntry(`run.${org}.create.success.${runnerType}`);
  }

  /* istanbul ignore next */
  runnersRepoCreateFail(repo: Repo, runnerType: string) {
    this.countEntry(`run.${repo.owner}.${repo.repo}.create.fail.total`);
    this.countEntry(`run.${repo.owner}.${repo.repo}.create.fail.${runnerType}`);
  }

  /* istanbul ignore next */
  runnersOrgCreateFail(org: string, runnerType: string) {
    this.countEntry(`run.${org}.create.fail.total`);
    this.countEntry(`run.${org}.create.fail.${runnerType}`);
  }
}

export class ScaleDownMetrics extends Metrics {
  constructor() {
    super('scaleDown');
  }

  /* istanbul ignore next */
  run() {
    this.countEntry('run.count');
  }

  /* istanbul ignore next */
  runnerLessMinimumTime(ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.notMinTime`);
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.notMinTime`);
  }

  /* istanbul ignore next */
  runnerFound(ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.total`);
    if (ec2Runner.runnerType !== undefined) {
      this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.total`);
    }

    if (ec2Runner.launchTime !== undefined) {
      const tm = (Date.now() - ec2Runner.launchTime.getTime()) / 1000;
      this.addEntry(`run.ec2runners.runningWallclock`, tm);
      if (ec2Runner.runnerType !== undefined) {
        this.addEntry(`run.ec2runners.${ec2Runner.runnerType}.runningWallclock`, tm);
      }
    }
  }

  /* istanbul ignore next */
  runnerGhFoundBusyRepo(repo: Repo, ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.total`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.total`);

    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.found`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.busy`);

    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.busy`);

    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.busy`);
  }

  /* istanbul ignore next */
  runnerGhFoundNonBusyRepo(repo: Repo, ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.total`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.total`);

    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.found`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.free`);

    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.free`);

    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.free`);
  }

  /* istanbul ignore next */
  runnerGhNotFoundRepo(repo: Repo, ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.total`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.total`);

    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.notFound`);
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.notFound`);
    this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.notFound`);
  }

  /* istanbul ignore next */
  runnerGhFoundBusyOrg(org: string, ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.${org}.total`);
    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.total`);

    this.countEntry(`run.ec2runners.${org}.found`);
    this.countEntry(`run.ec2runners.${org}.busy`);

    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.busy`);

    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.busy`);
  }

  /* istanbul ignore next */
  runnerGhFoundNonBusyOrg(org: string, ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.${org}.total`);
    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.total`);

    this.countEntry(`run.ec2runners.${org}.found`);
    this.countEntry(`run.ec2runners.${org}.free`);

    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.free`);

    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.found`);
    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.free`);
  }

  /* istanbul ignore next */
  runnerGhNotFoundOrg(org: string, ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.${org}.total`);
    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.total`);

    this.countEntry(`run.ec2runners.${org}.notFound`);
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.notFound`);
    this.countEntry(`run.ec2runners.${org}.${ec2Runner.runnerType}.notFound`);
  }

  /* istanbul ignore next */
  runnerTerminateSuccess(ec2Runner: RunnerInfo) {
    this.countEntry('run.ec2Runners.terminate.success');
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.terminate.success`);

    if (ec2Runner.org !== undefined) {
      this.countEntry(`run.ec2runners.${ec2Runner.org}.${ec2Runner.runnerType}.terminate.success`);
      this.countEntry(`run.ec2runners.${ec2Runner.org}.terminate.success`);
    }

    if (ec2Runner.repo !== undefined) {
      const repo = getRepo(ec2Runner.repo as string);
      this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.terminate.success`);
      this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.terminate.success`);
    }
  }

  /* istanbul ignore next */
  runnerTerminateFailure(ec2Runner: RunnerInfo) {
    this.countEntry('run.ec2Runners.terminate.failure');
    this.countEntry(`run.ec2runners.${ec2Runner.runnerType}.terminate.failure`);

    if (ec2Runner.org !== undefined) {
      this.countEntry(`run.ec2runners.${ec2Runner.org}.${ec2Runner.runnerType}.terminate.failure`);
      this.countEntry(`run.ec2runners.${ec2Runner.org}.terminate.failure`);
    }

    if (ec2Runner.repo !== undefined) {
      const repo = getRepo(ec2Runner.repo as string);
      this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.${ec2Runner.runnerType}.terminate.failure`);
      this.countEntry(`run.ec2runners.${repo.owner}.${repo.repo}.terminate.failure`);
    }
  }
}
