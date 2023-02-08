import { sqsSendMessages, sqsChangeMessageVisibilityBatch, sqsDeleteMessageBatch } from './sqs';
import { ActionRequestMessage } from './scale-up';
import * as MetricsModule from './metrics';
import nock from 'nock';
import { SQSRecord } from 'aws-lambda';

const mockCloudWatch = {
  putMetricData: jest.fn().mockImplementation(() => {
    return { promise: jest.fn().mockResolvedValue(true) };
  }),
};
const deleteMessageBatchPromise = jest.fn();
const mockSQS = {
  changeMessageVisibilityBatch: jest.fn().mockReturnValue({ promise: jest.fn() }),
  deleteMessageBatch: jest.fn().mockReturnValue({ promise: deleteMessageBatchPromise }),
  endpoint: { href: 'AGDGADUWG113' },
  sendMessageBatch: jest.fn().mockReturnValue({ promise: jest.fn() }),
};
jest.mock('aws-sdk', () => ({
  SQS: jest.fn().mockImplementation(() => mockSQS),
  CloudWatch: jest.fn().mockImplementation(() => mockCloudWatch),
}));

const metrics = new MetricsModule.ScaleUpMetrics();

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

describe('sqs', () => {
  const actionReqMsg: Array<ActionRequestMessage> = [
    {
      id: 1,
      eventType: 'sqs',
      repositoryName: 'AGDGADUWG113',
      repositoryOwner: 'pytorch',
      delaySeconds: 113,
    },
    {
      id: 2,
      eventType: 'sqs',
      repositoryName: 'AGDGADUWG113',
      repositoryOwner: 'pytorch',
      delaySeconds: 33,
    },
  ];
  const sqsRecords: Array<SQSRecord> = [
    {
      messageId: '1',
      receiptHandle: 'ASDF',
      body: '',
      attributes: {},
      messageAttributes: {},
      md5OfBody: 'string',
      eventSource: 'string',
      eventSourceARN: '1:2:3:4:5:6:7',
      awsRegion: 'string',
    } as unknown as SQSRecord,
    {
      messageId: '2',
      receiptHandle: 'AGDGADUWG113',
      body: '',
      attributes: {},
      messageAttributes: {},
      md5OfBody: 'string',
      eventSource: 'string',
      eventSourceARN: '1:2:3:4:5:6:7',
      awsRegion: 'string',
    } as unknown as SQSRecord,
  ];

  it('sqsSendMessages', async () => {
    await sqsSendMessages(metrics, actionReqMsg, 'queueURL');
    expect(mockSQS.sendMessageBatch).toBeCalledWith({
      QueueUrl: 'queueURL',
      Entries: [
        {
          Id: '0',
          DelaySeconds: 113,
          MessageBody:
            '{"id":1,"eventType":"sqs","repositoryName":"AGDGADUWG113","repositoryOwner":"pytorch","delaySeconds":113}',
        },
        {
          Id: '1',
          DelaySeconds: 33,
          MessageBody:
            '{"id":2,"eventType":"sqs","repositoryName":"AGDGADUWG113","repositoryOwner":"pytorch","delaySeconds":33}',
        },
      ],
    });
  });

  it('sqsChangeMessageVisibilityBatch', async () => {
    await sqsChangeMessageVisibilityBatch(metrics, sqsRecords, 0);
    expect(mockSQS.changeMessageVisibilityBatch).toBeCalledWith({
      QueueUrl: 'AGDGADUWG1135/6',
      Entries: [
        {
          Id: '1',
          ReceiptHandle: 'ASDF',
          VisibilityTimeout: 0,
        },
        {
          Id: '2',
          ReceiptHandle: 'AGDGADUWG113',
          VisibilityTimeout: 0,
        },
      ],
    });
  });

  it('sqsDeleteMessageBatch - succeed all', async () => {
    deleteMessageBatchPromise.mockResolvedValue({
      Failed: [],
      Successful: sqsRecords,
    });
    await sqsDeleteMessageBatch(metrics, sqsRecords);
    expect(mockSQS.deleteMessageBatch).toBeCalledTimes(1);
    expect(mockSQS.deleteMessageBatch).toBeCalledWith({
      QueueUrl: 'AGDGADUWG1135/6',
      Entries: [
        {
          Id: '1',
          ReceiptHandle: 'ASDF',
        },
        {
          Id: '2',
          ReceiptHandle: 'AGDGADUWG113',
        },
      ],
    });
  });

  it('sqsDeleteMessageBatch - fail all', async () => {
    deleteMessageBatchPromise.mockResolvedValue({
      Failed: sqsRecords,
      Successful: [],
    });
    expect(sqsDeleteMessageBatch(metrics, sqsRecords)).rejects.toThrowError();
    expect(mockSQS.deleteMessageBatch).toBeCalledTimes(1);
    expect(mockSQS.deleteMessageBatch).toBeCalledWith({
      QueueUrl: 'AGDGADUWG1135/6',
      Entries: [
        {
          Id: '1',
          ReceiptHandle: 'ASDF',
        },
        {
          Id: '2',
          ReceiptHandle: 'AGDGADUWG113',
        },
      ],
    });
  });
});
