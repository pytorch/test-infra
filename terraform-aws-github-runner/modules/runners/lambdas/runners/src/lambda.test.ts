import { scaleDown as scaleDownL, scaleUp as scaleUpL } from './lambda';

import nock from 'nock';
import { Config } from './scale-runners/config';
import { Context, SQSEvent, ScheduledEvent } from 'aws-lambda';
import { mocked } from 'ts-jest/utils';
import { scaleDown } from './scale-runners/scale-down';
import { scaleUp, RetryableScalingError } from './scale-runners/scale-up';
import { sqsSendMessages, sqsDeleteMessageBatch } from './scale-runners/sqs';
import * as MetricsModule from './scale-runners/metrics';

const mockCloudWatch = {
  putMetricData: jest.fn().mockImplementation(() => {
    return { promise: jest.fn().mockResolvedValue(true) };
  }),
};
jest.mock('aws-sdk', () => ({
  CloudWatch: jest.fn().mockImplementation(() => mockCloudWatch),
}));

jest.mock('./scale-runners/scale-down');
jest.mock('./scale-runners/scale-up');
jest.mock('./scale-runners/sqs');

const metrics = new MetricsModule.ScaleUpMetrics();

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

describe('scaleUp', () => {
  beforeEach(() => {
    jest.spyOn(global.Math, 'random').mockReturnValue(1.0);
    jest.spyOn(MetricsModule, 'ScaleUpMetrics').mockReturnValue(metrics);
  });

  afterEach(() => {
    jest.spyOn(global.Math, 'random').mockRestore();
  });

  it('succeeds', async () => {
    const mockedScaleUp = mocked(scaleUp).mockResolvedValue(undefined);
    const callback = jest.fn();
    await scaleUpL(
      {
        Records: [
          { eventSource: 'aws:sqs', body: '{"id":1}', eventSourceARN: '1:2:3:4:5:6' },
          { eventSource: 'aws:sqs', body: '{"id":2}', eventSourceARN: '1:2:3:4:5:6' },
        ],
      } as unknown as SQSEvent,
      {} as unknown as Context,
      callback,
    );
    expect(mockedScaleUp).toBeCalledTimes(2);
    expect(mockedScaleUp).toBeCalledWith('aws:sqs', { id: 1 }, metrics);
    expect(mockedScaleUp).toBeCalledWith('aws:sqs', { id: 2 }, metrics);
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(null);
  });

  it('fails', async () => {
    const mockedScaleUp = mocked(scaleUp).mockRejectedValue(Error('error'));
    const callback = jest.fn();
    const evts = [
      {
        eventSource: 'aws:sqs',
        body: '{"id":1}',
        eventSourceARN: '1:2:3:4:5:6',
        receiptHandle: 'xxx',
        messageId: 1,
      },
      {
        eventSource: 'aws:sqs',
        body: '{"id":2}',
        eventSourceARN: '1:2:3:4:5:6',
        receiptHandle: 'xxx',
        messageId: 2,
      },
    ];
    await scaleUpL(
      {
        Records: evts,
      } as unknown as SQSEvent,
      {} as unknown as Context,
      callback,
    );
    expect(mockedScaleUp).toBeCalledTimes(1);
    expect(mockedScaleUp).toBeCalledWith('aws:sqs', { id: 1 }, metrics);
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith('Failed handling SQS event');

    expect(sqsDeleteMessageBatch).toBeCalledTimes(1);
    expect(sqsDeleteMessageBatch).toBeCalledWith(metrics, evts);
  });

  it('stochasticOvershoot when retryCount > 5', async () => {
    const config = {
      maxRetryScaleUpRecord: 1999,
      retryScaleUpRecordDelayS: 20,
      retryScaleUpRecordJitterPct: 0.2,
      retryScaleUpRecordQueueUrl: 'asdf',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const records = [
      { eventSource: 'aws:sqs', body: '{"id":1}', eventSourceARN: '1:2:3:4:5:6', receiptHandle: 'xxx', messageId: 1 },
      {
        eventSource: 'aws:sqs',
        body: '{"id":2,"retryCount":3}',
        eventSourceARN: '1:2:3:4:5:6:7',
        receiptHandle: 'xxx',
        messageId: 2,
      },
      {
        eventSource: 'aws:sqs',
        body: '{"id":3,"retryCount":12}',
        eventSourceARN: '1:2:3:4:5:6:7',
        receiptHandle: 'xxx',
        messageId: 3,
      },
    ];

    const mockedScaleUp = mocked(scaleUp).mockResolvedValue(undefined);
    jest.spyOn(global.Math, 'random').mockReturnValue(0.5);

    const callback = jest.fn();
    await scaleUpL({ Records: records } as unknown as SQSEvent, {} as unknown as Context, callback);
    expect(mockedScaleUp).toBeCalledTimes(2);

    const expected = [
      {
        id: 3,
        retryCount: 12,
        delaySeconds: 900,
      },
    ];
    expect(sqsSendMessages).toBeCalledTimes(1);
    expect(sqsSendMessages).toBeCalledWith(metrics, expected, 'asdf');

    expect(sqsDeleteMessageBatch).toBeCalledTimes(0);
  });

  it('RetryableScalingError', async () => {
    const config = {
      maxRetryScaleUpRecord: 12,
      retryScaleUpRecordDelayS: 20,
      retryScaleUpRecordJitterPct: 0.2,
      retryScaleUpRecordQueueUrl: 'asdf',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
    const records = [
      { eventSource: 'aws:sqs', body: '{"id":1}', eventSourceARN: '1:2:3:4:5:6', receiptHandle: 'xxx', messageId: 1 },
      { eventSource: 'aws:sqs', body: '{"id":2}', eventSourceARN: '1:2:3:4:5:6', receiptHandle: 'xxx', messageId: 2 },
      { eventSource: 'aws:sqs', body: '{"id":3}', eventSourceARN: '1:2:3:4:5:6', receiptHandle: 'xxx', messageId: 3 },
      {
        eventSource: 'aws:sqs',
        body: '{"id":4,"retryCount":3}',
        eventSourceARN: '1:2:3:4:5:6:7',
        receiptHandle: 'xxx',
        messageId: 4,
      },
      {
        eventSource: 'aws:sqs',
        body: '{"id":5,"retryCount":12}',
        eventSourceARN: '1:2:3:4:5:6:7',
        receiptHandle: 'xxx',
        messageId: 5,
      },
      { eventSource: 'aws:sqs', body: '{"id":6}', eventSourceARN: '1:2:3:4:5:6', receiptHandle: 'xxx', messageId: 6 },
      { eventSource: 'aws:sqs', body: '{"id":7}', eventSourceARN: '1:2:3:4:5:6', receiptHandle: 'xxx', messageId: 7 },
    ];
    const mockedScaleUp = mocked(scaleUp)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RetryableScalingError('whatever'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RetryableScalingError('whatever'))
      .mockRejectedValueOnce(new RetryableScalingError('whatever'))
      .mockRejectedValueOnce(new Error('whatever'));
    const callback = jest.fn();
    await scaleUpL({ Records: records } as unknown as SQSEvent, {} as unknown as Context, callback);
    expect(mockedScaleUp).toBeCalledTimes(6);

    const expected = [
      {
        id: 2,
        retryCount: 1,
        delaySeconds: 24,
      },
      {
        id: 4,
        retryCount: 4,
        delaySeconds: 192,
      },
      {
        id: 6,
        retryCount: 1,
        delaySeconds: 24,
      },
      {
        id: 7,
        retryCount: 1,
        delaySeconds: 24,
      },
    ];
    expect(sqsSendMessages).toBeCalledTimes(1);
    expect(sqsSendMessages).toBeCalledWith(metrics, expected, 'asdf');

    expect(sqsDeleteMessageBatch).toBeCalledTimes(1);
    expect(sqsDeleteMessageBatch).toBeCalledWith(metrics, records);
  });
});

describe('scaleDown', () => {
  it('succeeds', async () => {
    const mockedScaleDown = mocked(scaleDown).mockResolvedValue(undefined);
    const callback = jest.fn();
    await scaleDownL({} as unknown as ScheduledEvent, {} as unknown as Context, callback);
    expect(mockedScaleDown).toBeCalledTimes(1);
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(null);
  });

  it('fails', async () => {
    const mockedScaleDown = mocked(scaleDown).mockRejectedValue(Error('error'));
    const callback = jest.fn();
    await scaleDownL({} as unknown as ScheduledEvent, {} as unknown as Context, callback);
    expect(mockedScaleDown).toBeCalledTimes(1);
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith('Failed');
  });
});
