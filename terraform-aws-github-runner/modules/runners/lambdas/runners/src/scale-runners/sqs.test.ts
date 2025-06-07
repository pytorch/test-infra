import { sqsSendMessages, sqsChangeMessageVisibilityBatch, sqsDeleteMessageBatch } from './sqs';
import { ActionRequestMessage } from './scale-up';
import * as MetricsModule from './metrics';
import nock from 'nock';
import { SQSRecord } from 'aws-lambda';

// Mock AWS SDK v3 clients
const mockSQSSend = jest.fn();
const mockCloudWatchSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({
    send: mockSQSSend,
  })),
  SendMessageBatchCommand: jest.fn().mockImplementation((params) => params),
  ChangeMessageVisibilityBatchCommand: jest.fn().mockImplementation((params) => params),
  DeleteMessageBatchCommand: jest.fn().mockImplementation((params) => params),
}));

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockCloudWatchSend,
  })),
  PutMetricDataCommand: jest.fn().mockImplementation((params) => params),
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
    expect(mockSQSSend).toBeCalledWith({
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
    expect(mockSQSSend).toBeCalledWith({
      QueueUrl: 'https://sqs.4.amazonaws.com/5/6',
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
    mockSQSSend.mockResolvedValue({
      Failed: [],
      Successful: sqsRecords,
    });
    await sqsDeleteMessageBatch(metrics, sqsRecords);
    expect(mockSQSSend).toBeCalledTimes(1);
    expect(mockSQSSend).toBeCalledWith({
      QueueUrl: 'https://sqs.4.amazonaws.com/5/6',
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
    mockSQSSend.mockResolvedValue({
      Failed: sqsRecords,
      Successful: [],
    });
    expect(sqsDeleteMessageBatch(metrics, sqsRecords)).rejects.toThrowError();
    expect(mockSQSSend).toBeCalledTimes(1);
    expect(mockSQSSend).toBeCalledWith({
      QueueUrl: 'https://sqs.4.amazonaws.com/5/6',
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
