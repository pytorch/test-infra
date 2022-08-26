import { CloudWatch } from 'aws-sdk';
import { Config } from './config';
import { expBackOff, Repo } from './utils';

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
  protected get metricTypes() {
    return Metrics.baseMetricTypes;
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

  async sendMetrics() {
    if (this.metrics.size < 1) {
      return;
    }

    const timestamp = new Date();
    const awsMetrics = {
      MetricData: new Array<CloudWatchMetric>(),
      Namespace: `${Config.Instance.environment}-${this.lambda}`,
    };

    this.metrics.forEach((vals, name) => {
      const dt: CloudWatchMetric = {
        Counts: [],
        MetricName: name,
        Timestamp: timestamp,
        Unit: this.metricTypes.get(name) || 'Count',
        Values: [],
      };

      vals.forEach((count, val) => {
        dt.Counts.push(count);
        dt.Values.push(val);
      });

      awsMetrics.MetricData.push(dt);
    });

    await expBackOff(() => {
      return this.cloudwatch.putMetricData(awsMetrics).promise();
    });
  }
}

export class ScaleUpMetrics extends Metrics {
  static baseMetricTypes = new Map<string, string>([['gh.calls.getRunnerTypes.wallclock', 'Milliseconds']]);

  constructor() {
    super('scaleUp');
  }

  protected get metricTypes() {
    return ScaleUpMetrics.baseMetricTypes;
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
  getRunnerTypesGHCall(ms: number) {
    this.countEntry(`gh.calls.getRunnerTypes.count`, 1);
    this.addEntry(`gh.calls.getRunnerTypes.wallclock`, ms);
  }
}
