import { ActionRequestMessage } from './scale-up';
import { SQS } from 'aws-sdk';
import { SQSRecord } from 'aws-lambda';

import { expBackOff } from './utils';
import { Metrics } from './metrics';

function getQueueUrl(evt: SQSRecord, sqs: SQS) {
  const splitARN = evt.eventSourceARN.split(':');
  const accountId = splitARN[4];
  const queueName = splitARN[5];
  return sqs.endpoint.href + accountId + '/' + queueName;
}

export async function sqsSendMessages(metrics: Metrics, bodyList: Array<ActionRequestMessage>, queueUrl: string) {
  const sqs: SQS = new SQS();

  const sqsPayload: SQS.SendMessageBatchRequest = {
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
      return sqs.sendMessageBatch(sqsPayload).promise();
    });
  });
  console.log(`Sent ${bodyList.length} messages to ${queueUrl}`);
}

export async function sqsChangeMessageVisibilityBatch(
  metrics: Metrics,
  events: Array<SQSRecord>,
  visibilityTimeout: number,
) {
  const sqs: SQS = new SQS();

  const queueUrl = getQueueUrl(events[0], sqs);
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
        return sqs.changeMessageVisibilityBatch(parameters).promise();
      },
    );
  });
  console.log(`Changed visibility of ${events.length} messages`);
}

export async function sqsDeleteMessageBatch(metrics: Metrics, events: Array<SQSRecord>) {
  const sqs: SQS = new SQS();

  const queueUrl = getQueueUrl(events[0], sqs);
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
      return sqs.deleteMessageBatch(parameters).promise();
    });
  });
  if (response.Failed.length || response.Successful.length < events.length) {
    const msg =
      `Failed to delete messages from SQS, this might cause them to be retried. Total: ${events.length} ` +
      `Successful: ${response.Successful.length} Failed: ${response.Failed.length}`;
    console.error(msg);
    throw Error(msg);
  }
  console.log(`Deleted ${events.length} messages`);
}
