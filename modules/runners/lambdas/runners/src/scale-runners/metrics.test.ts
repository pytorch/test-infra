import { Config } from './config';
import { ScaleUpMetrics } from './metrics';
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
      m.getRunnerTypesGHCall(113);
      m.getRunnerTypesGHCall(33);
      m.getRunnerTypesGHCall(113);
      m.sendMetrics();

      expect(mockCloudWatch.putMetricData).toBeCalledWith({
        MetricData: [
          {
            Counts: [1],
            MetricName: 'gh.calls.getRunnerTypes.count',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Count',
            Values: [3],
          },
          {
            Counts: [2, 1],
            MetricName: 'gh.calls.getRunnerTypes.wallclock',
            Timestamp: spyDate.mock.instances[0],
            Unit: 'Milliseconds',
            Values: [113, 33],
          },
        ],
        Namespace: 'environ-scaleUp',
      });
    });
  });
});
