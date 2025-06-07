import { ActionRequestMessage } from './scale-up';
import {
  SQSClient,
  SendMessageBatchCommand,
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import { SQSRecord } from 'aws-lambda';

import { expBackOff } from './utils';
import { Metrics } from './metrics';

function getQueueUrl(evt: SQSRecord): string {
  const splitARN = evt.eventSourceARN.split(':');
  const accountId = splitARN[4];
  const queueName = splitARN[5];
  const region = splitARN[3];
  return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
}

export async function sqsSendMessages(metrics: Metrics, bodyList: Array<ActionRequestMessage>, queueUrl: string) {
  const sqs = new SQSClient({});

  const sqsPayload = {
    QueueUrl: queueUrl,
    Entries: bodyList.map((body, idx) => {
      return {
        Id: `${idx}`,
        DelaySeconds: body.delaySeconds ?? 0,
        MessageBody: JSON.stringify(body),
      };
    }),
  };

  console.log(`Sending ${bodyList.length} messages to ${queueUrl}`);
  await expBackOff(() => {
    return metrics.trackRequest(metrics.sqsSendMessagesBatchSuccess, metrics.sqsSendMessagesBatchFailure, () => {
      return sqs.send(new SendMessageBatchCommand(sqsPayload));
    });
  });
  console.log(`Sent ${bodyList.length} messages to ${queueUrl}`);
}

export async function sqsChangeMessageVisibilityBatch(
  metrics: Metrics,
  events: Array<SQSRecord>,
  visibilityTimeout: number,
) {
  const sqs = new SQSClient({});

  const queueUrl = getQueueUrl(events[0]);
  const parameters = {
    Entries: events.map((evt) => {
      return {
        Id: evt.messageId,
        ReceiptHandle: evt.receiptHandle,
        VisibilityTimeout: visibilityTimeout,
      };
    }),
    QueueUrl: queueUrl,
  };

  console.log(`Changing visibility of ${events.length} messages`);
  await expBackOff(() => {
    return metrics.trackRequest(
      metrics.sqsChangeMessageVisibilityBatchSuccess,
      metrics.sqsChangeMessageVisibilityBatchFailure,
      () => {
        return sqs.send(new ChangeMessageVisibilityBatchCommand(parameters));
      },
    );
  });
  console.log(`Changed visibility of ${events.length} messages`);
}

export async function sqsDeleteMessageBatch(metrics: Metrics, events: Array<SQSRecord>) {
  const sqs = new SQSClient({});

  const queueUrl = getQueueUrl(events[0]);
  const parameters = {
    Entries: events.map((evt) => {
      return {
        Id: evt.messageId,
        ReceiptHandle: evt.receiptHandle,
      };
    }),
    QueueUrl: queueUrl,
  };

  console.log(`Deleting ${events.length} messages`);
  const response = await expBackOff(() => {
    return metrics.trackRequest(metrics.sqsDeleteMessageBatchSuccess, metrics.sqsDeleteMessageBatchFailure, () => {
      return sqs.send(new DeleteMessageBatchCommand(parameters));
    });
  });
  if (response.Failed?.length || (response.Successful?.length ?? 0) < events.length) {
    const msg =
      `Failed to delete messages from SQS, this might cause them to be retried. Total: ${events.length} ` +
      `Successful: ${response.Successful?.length ?? 0} Failed: ${response.Failed?.length ?? 0}`;
    console.error(msg);
    throw Error(msg);
  }
  console.log(`Deleted ${events.length} messages`);
}
