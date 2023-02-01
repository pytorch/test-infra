import { scaleDown as scaleDownL, scaleUp as scaleUpL } from './lambda';

import nock from 'nock';
import { Config } from './scale-runners/config';
import { Context, SQSEvent, ScheduledEvent } from 'aws-lambda';
import { mocked } from 'ts-jest/utils';
import { scaleDown } from './scale-runners/scale-down';
import { scaleUp, RetryableScalingError } from './scale-runners/scale-up';
import * as MetricsModule from './scale-runners/metrics';

const mockCloudWatch = {
  putMetricData: jest.fn().mockImplementation(() => {
    return { promise: jest.fn().mockResolvedValue(true) };
  }),
};
const mockSQS = {
  changeMessageVisibilityBatch: jest.fn().mockReturnValue({ promise: jest.fn() }),
  deleteMessageBatch: jest.fn().mockReturnValue({ promise: jest.fn() }),
  endpoint: { href: 'AGDGADUWG113' },
  sendMessage: jest.fn().mockReturnValue({ promise: jest.fn() }),
};
jest.mock('aws-sdk', () => ({
  SQS: jest.fn().mockImplementation(() => mockSQS),
  CloudWatch: jest.fn().mockImplementation(() => mockCloudWatch),
}));

jest.mock('./scale-runners/scale-down');
jest.mock('./scale-runners/scale-up');

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
    await scaleUpL(
      {
        Records: [
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
        ],
      } as unknown as SQSEvent,
      {} as unknown as Context,
      callback,
    );
    expect(mockedScaleUp).toBeCalledTimes(1);
    expect(mockedScaleUp).toBeCalledWith('aws:sqs', { id: 1 }, metrics);
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith('Failed handling SQS event');

    expect(mockSQS.changeMessageVisibilityBatch).toBeCalledTimes(1);
    expect(mockSQS.changeMessageVisibilityBatch).toBeCalledWith({
      QueueUrl: 'AGDGADUWG1135/6',
      Entries: [
        {
          Id: 1,
          ReceiptHandle: 'xxx',
          VisibilityTimeout: 0,
        },
        {
          Id: 2,
          ReceiptHandle: 'xxx',
          VisibilityTimeout: 0,
        },
      ],
    });
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
        eventSourceARN: '1:2:3:4:5:6',
        receiptHandle: 'xxx',
        messageId: 4,
      },
      {
        eventSource: 'aws:sqs',
        body: '{"id":5,"retryCount":12}',
        eventSourceARN: '1:2:3:4:5:6',
        receiptHandle: 'xxx',
        messageId: 5,
      },
      { eventSource: 'aws:sqs', body: '{"id":6}', eventSourceARN: '1:2:3:4:5:6', receiptHandle: 'xxx', messageId: 6 },
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

    expect(mockSQS.sendMessage).toBeCalledTimes(3);
    expect(mockSQS.sendMessage).toBeCalledWith({
      DelaySeconds: 24,
      MessageBody: '{"id":2,"retryCount":1,"delaySeconds":24}',
      QueueUrl: 'asdf',
    });
    expect(mockSQS.sendMessage).toBeCalledWith({
      DelaySeconds: 192,
      MessageBody: '{"id":4,"retryCount":4,"delaySeconds":192}',
      QueueUrl: 'asdf',
    });
    expect(mockSQS.sendMessage).toBeCalledWith({
      DelaySeconds: 24,
      MessageBody: '{"id":6,"retryCount":1,"delaySeconds":24}',
      QueueUrl: 'asdf',
    });

    expect(mockSQS.deleteMessageBatch).toBeCalledTimes(1);
    expect(mockSQS.deleteMessageBatch).toBeCalledWith({
      QueueUrl: 'AGDGADUWG1135/6',
      Entries: [
        {
          Id: 1,
          ReceiptHandle: 'xxx',
        },
        {
          Id: 2,
          ReceiptHandle: 'xxx',
        },
        {
          Id: 3,
          ReceiptHandle: 'xxx',
        },
        {
          Id: 4,
          ReceiptHandle: 'xxx',
        },
        {
          Id: 5,
          ReceiptHandle: 'xxx',
        },
      ],
    });

    expect(mockSQS.changeMessageVisibilityBatch).toBeCalledTimes(1);
    expect(mockSQS.changeMessageVisibilityBatch).toBeCalledWith({
      QueueUrl: 'AGDGADUWG1135/6',
      Entries: [
        {
          Id: 6,
          ReceiptHandle: 'xxx',
          VisibilityTimeout: 0,
        },
      ],
    });
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
