import { Config } from './config';
import { ScaleUpMetrics, ScaleDownMetrics } from './metrics';
import nock from 'nock';

const mockCloudWatch = {
  putMetricData: jest.fn().mockImplementation(() => {
    return { promise: jest.fn().mockResolvedValue(true) };
  }),
};

jest.mock('aws-sdk', () => ({
  CloudWatch: jest.fn().mockImplementation(() => mockCloudWatch),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
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

    it('sends empty metrics', async () => {
      const m = new ScaleUpMetrics();
      m.sendMetrics();
      expect(mockCloudWatch.putMetricData).not.toBeCalled();
    });

    it('generate some countEntry, then sends', async () => {
      const spyDate = jest.spyOn(global, 'Date');

      const m = new ScaleUpMetrics();
      m.runRepo({ owner: 'o', repo: 'r' });
      m.runRepo({ owner: 'o', repo: 'r' });
      m.runRepo({ owner: 'o', repo: 'r' });
      m.sendMetrics();

      expect(mockCloudWatch.putMetricData).toBeCalledWith({
        MetricData: [
          {
            Counts: [1],
            MetricName: 'run.o.r.process',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [3],
          },
        ],
        Namespace: 'environ-scaleUp',
      });
    });

    it('generate some addEntry, then sends', async () => {
      const spyDate = jest.spyOn(global, 'Date');

      const m = new ScaleUpMetrics();
      m.createAppAuthGHCallSuccess(113);
      m.createAppAuthGHCallSuccess(33);
      m.createAppAuthGHCallFailure(113);
      m.sendMetrics();

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
        Namespace: 'environ-scaleUp',
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
      expect(timeDiff).toBeGreaterThanOrEqual(waitMs);
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
      expect(timeDiff).toBeGreaterThanOrEqual(waitMs);
      expect(successFn).not.toBeCalled();
      expect(failFn).toBeCalledWith(timeDiff);
    });
  });
});
