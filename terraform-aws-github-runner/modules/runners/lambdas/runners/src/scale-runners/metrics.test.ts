import { Config } from './config';
import { ScaleUpMetrics, ScaleDownMetrics } from './metrics';
import * as cache from './cache';
import { CHFactory } from './clickhouse';
import nock from 'nock';
import { mocked } from 'ts-jest/utils';

const mockCloudWatch = {
  putMetricData: jest.fn().mockImplementation(() => {
    return { promise: jest.fn().mockResolvedValue(true) };
  }),
};

const mockClickHouseClient = {
  insert: jest.fn().mockResolvedValue(true),
};

// Classes that expose protected methods for testing
class TestMetrics extends ScaleUpMetrics {
  constructor(lambdaName: string) {
    super(lambdaName);
  }

  public async sendMetricsCW() {
    return this._sendMetricsCW();
  }

  public async sendMetricsCH() {
    return this._sendMetricsCH();
  }
}

class IsolatedTestMetrics extends ScaleUpMetrics {
  constructor(lambdaName: string) {
    super(lambdaName);
  }

  protected async _sendMetricsCW(): Promise<void> {
    return Promise.resolve();
  }

  protected async _sendMetricsCH(): Promise<void> {
    return Promise.resolve();
  }
}

jest.mock('aws-sdk', () => ({
  CloudWatch: jest.fn().mockImplementation(() => mockCloudWatch),
}));

jest.mock('./clickhouse', () => {
  return {
    CHFactory: {
      instance: {
        getClient: jest.fn(),
      },
    },
  };
});

jest.mock('./cache', () => {
  return {
    getExperimentJoined: jest.fn(),
  };
});

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();

  CHFactory.instance.getClient = jest.fn().mockReturnValue(mockClickHouseClient);
});

afterEach(() => {
  nock.cleanAll();
  jest.useRealTimers();
});

describe('./metrics', () => {
  describe('Metrics', () => {
    beforeEach(() => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            environment: 'environ',
            awsRegion: 'region',
          } as unknown as Config),
      );
    });

    it('_sendMetricsCW sends empty metrics', async () => {
      const m = new TestMetrics('test');
      await m.sendMetricsCW();
      expect(mockCloudWatch.putMetricData).not.toBeCalled();
    });

    it('_sendMetricsCW generates some countEntry, then sends', async () => {
      const spyDate = jest.spyOn(global, 'Date');

      const m = new ScaleUpMetrics();
      m.runRepo({ owner: 'o', repo: 'r' });
      m.runRepo({ owner: 'o', repo: 'r' });
      m.runRepo({ owner: 'o', repo: 'r' });
      m.runRepo({ owner: 'o', repo: 'r1' });
      m.runRepo({ owner: 'o', repo: 'r1' });

      // Mock getExperimentJoined to return false so only _sendMetricsCW is called
      mocked(cache.getExperimentJoined).mockResolvedValueOnce(false);
      await m.sendMetrics();

      expect(mockCloudWatch.putMetricData).toBeCalledWith({
        MetricData: [
          {
            Counts: [1],
            Dimensions: [
              {
                Name: 'Owner',
                Value: 'o',
              },
              {
                Name: 'Repo',
                Value: 'r',
              },
            ],
            MetricName: 'run.process',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [3],
          },
          {
            Counts: [1],
            Dimensions: [
              {
                Name: 'Owner',
                Value: 'o',
              },
              {
                Name: 'Repo',
                Value: 'r1',
              },
            ],
            MetricName: 'run.process',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [2],
          },
        ],
        Namespace: 'environ-scaleUp-dim',
      });
    });

    it('_sendMetricsCW generates some addEntry, then sends', async () => {
      const spyDate = jest.spyOn(global, 'Date');

      const m = new ScaleUpMetrics();
      m.createAppAuthGHCallSuccess(113);
      m.createAppAuthGHCallSuccess(33);
      m.createAppAuthGHCallFailure(113);

      // Mock getExperimentJoined to return false so only _sendMetricsCW is called
      mocked(cache.getExperimentJoined).mockResolvedValueOnce(false);
      await m.sendMetrics();

      expect(mockCloudWatch.putMetricData).toBeCalledWith({
        MetricData: [
          {
            Counts: [1],
            MetricName: 'gh.calls.total',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [3],
          },
          {
            Counts: [1],
            MetricName: 'gh.calls.createAppAuth.count',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [3],
          },
          {
            Counts: [1],
            MetricName: 'gh.calls.createAppAuth.success',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [2],
          },
          {
            Counts: [2, 1],
            MetricName: 'gh.calls.createAppAuth.wallclock',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Milliseconds',
            Values: [113, 33],
          },
          {
            Counts: [1],
            MetricName: 'gh.calls.createAppAuth.failure',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [1],
          },
        ],
        Namespace: 'environ-scaleUp-dim',
      });
    });

    it('trackRequest + msTimer - calls success', async () => {
      const waitMs = 100;
      const m = new ScaleDownMetrics();
      const successFn = jest.fn();
      const failFn = jest.fn();
      const spyDate = jest.spyOn(Date, 'now');

      await m.trackRequest(successFn, failFn, () => {
        return new Promise((resolve) => setTimeout(resolve, waitMs));
      });

      const timeDiff = spyDate.mock.results[1].value - spyDate.mock.results[0].value;
      expect(timeDiff).toBeGreaterThanOrEqual(waitMs - 5);
      expect(successFn).toBeCalledWith(timeDiff);
      expect(failFn).not.toBeCalled();
    });

    it('trackRequest + msTimer - calls fails', async () => {
      const waitMs = 100;
      const m = new ScaleDownMetrics();
      const successFn = jest.fn();
      const failFn = jest.fn();
      const spyDate = jest.spyOn(Date, 'now');

      await expect(
        m.trackRequest(successFn, failFn, async () => {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          throw new Error('Yeahp, failed');
        }),
      ).rejects.toThrowError();

      const timeDiff = spyDate.mock.results[1].value - spyDate.mock.results[0].value;
      expect(timeDiff).toBeGreaterThanOrEqual(waitMs - 5);
      expect(successFn).not.toBeCalled();
      expect(failFn).toBeCalledWith(timeDiff);
    });

    it('_sendMetricsCH sends empty metrics', async () => {
      const m = new TestMetrics('test');
      await m.sendMetricsCH();
      expect(mockClickHouseClient.insert).not.toBeCalled();
    });

    describe('tests mocking time', () => {
      beforeEach(() => {
        jest.useFakeTimers('modern');
        jest.setSystemTime(new Date('2019-06-29T11:01:58.135Z'));
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('_sendMetricsCH sends metrics to ClickHouse', async () => {
        // Setup
        const m = new TestMetrics('test');
        m.runRepo({ owner: 'o', repo: 'r' });
        m.runRepo({ owner: 'o', repo: 'r' });
        m.runRepo({ owner: 'o', repo: 'r1' });

        // // Force timeBucket to be consistent for testing
        jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2019-06-29T11:01:58.135Z').valueOf());
        const expectDate = new Date('2019-06-29T11:01:00.000Z');

        await m.sendMetricsCH();

        // Verify ClickHouse client was called with correct parameters
        expect(mockClickHouseClient.insert).toHaveBeenCalledWith({
          table: 'fortesting.metrics_test',
          values: expect.arrayContaining([
            expect.objectContaining({
              namespace: 'environ-test-dim',
              metric_name: 'run.process',
              time_bucket: expectDate,
              dimensions: { Owner: 'o', Repo: 'r' },
              value: 2,
            }),
            expect.objectContaining({
              namespace: 'environ-test-dim',
              metric_name: 'run.process',
              time_bucket: expectDate,
              dimensions: { Owner: 'o', Repo: 'r1' },
              value: 1,
            }),
          ]),
          format: 'JSONEachRow',
        });
      });
    });

    it('sendMetrics with experiment enabled calls both _sendMetricsCW and _sendMetricsCH', async () => {
      // Setup mock for isolated testing
      const m = new IsolatedTestMetrics('test');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spyCW = jest.spyOn(m as any, '_sendMetricsCW');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spyCH = jest.spyOn(m as any, '_sendMetricsCH');

      // Mock getExperimentJoined to return true to enable ClickHouse metrics
      mocked(cache.getExperimentJoined).mockResolvedValueOnce(true);

      await m.sendMetrics();

      // Verify both metrics methods were called
      expect(cache.getExperimentJoined).toHaveBeenCalledWith('SendMetricsCH');
      expect(spyCW).toHaveBeenCalledTimes(1);
      expect(spyCH).toHaveBeenCalledTimes(1);
    });

    it('sendMetrics with experiment disabled only calls _sendMetricsCW', async () => {
      // Setup mock for isolated testing
      const m = new IsolatedTestMetrics('test');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spyCW = jest.spyOn(m as any, '_sendMetricsCW');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spyCH = jest.spyOn(m as any, '_sendMetricsCH');

      // Mock getExperimentJoined to return false to disable ClickHouse metrics
      mocked(cache.getExperimentJoined).mockResolvedValueOnce(false);

      await m.sendMetrics();

      // Verify only CloudWatch metrics were called
      expect(cache.getExperimentJoined).toHaveBeenCalledWith('SendMetricsCH');
      expect(spyCW).toHaveBeenCalledTimes(1);
      expect(spyCH).not.toHaveBeenCalled();
    });
  });
});
