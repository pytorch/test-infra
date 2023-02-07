import { ActionRequestMessage, RetryableScalingError, scaleUp as scaleUpR } from './scale-runners/scale-up';
import { Context, SQSEvent, SQSRecord, ScheduledEvent } from 'aws-lambda';

import { Config } from './scale-runners/config';
import { SQS } from 'aws-sdk';
import { ScaleUpMetrics, sendMetricsAtTimeout, sendMetricsTimeoutVars } from './scale-runners/metrics';
import { getDelayWithJitterRetryCount } from './scale-runners/utils';
import { scaleDown as scaleDownR } from './scale-runners/scale-down';

async function sendRetryEvents(evtFailed: Array<[SQSRecord, boolean]>, metrics: ScaleUpMetrics) {
  console.error(`Detected ${evtFailed.length} errors when processing messages, will retry relevant messages.`);
  metrics.exception();

  const sqs: SQS = new SQS();

  for (const [evt, retryable] of evtFailed) {
    const body: ActionRequestMessage = JSON.parse(evt.body);
    const retryCount = body?.retryCount ?? 0;

    if (
      retryCount < Config.Instance.maxRetryScaleUpRecord &&
      (Config.Instance.retryScaleUpRecordQueueUrl?.length ?? 0) > 0
    ) {
      if (retryable) {
        metrics.scaleUpFailureRetryable(retryCount);
      } else {
        metrics.scaleUpFailureNonRetryable(retryCount);
      }

      body.retryCount = retryCount + 1;
      body.delaySeconds = Math.min(
        900,
        getDelayWithJitterRetryCount(
          retryCount,
          Math.max(Config.Instance.retryScaleUpRecordDelayS, 20),
          Config.Instance.retryScaleUpRecordJitterPct,
        ),
      );

      const sqsPayload: SQS.SendMessageRequest = {
        DelaySeconds: body.delaySeconds,
        MessageBody: JSON.stringify(body),
        QueueUrl: Config.Instance.retryScaleUpRecordQueueUrl as string,
      };

      await sqs.sendMessage(sqsPayload).promise();
      console.warn(`Sent message: ${evt.body}`);
    } else {
      console.error(`Permanently abandoning message: ${evt.body}`);
    }
  }
}

function getQueueUrl(evt: SQSRecord, sqs: SQS) {
  const splitARN = evt.eventSourceARN.split(':');
  const accountId = splitARN[4];
  const queueName = splitARN[5];
  return sqs.endpoint.href + accountId + '/' + queueName;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scaleUp(event: SQSEvent, context: Context, callback: any) {
  let success = false;
  const metrics = new ScaleUpMetrics();

  const sndMetricsTimout: sendMetricsTimeoutVars = {
    metrics: metrics,
  };
  sndMetricsTimout.setTimeout = setTimeout(
    sendMetricsAtTimeout(sndMetricsTimout),
    (Config.Instance.lambdaTimeout - 10) * 1000,
  );

  const evtFailed: Array<[SQSRecord, boolean]> = [];
  const evtDelete: Array<SQSRecord> = [];
  const evtVisible: Array<SQSRecord> = [];

  try {
    recordsIterProcess: for (let i = 0; i < event.Records.length; i += 1) {
      const evt = event.Records[i];

      try {
        await scaleUpR(evt.eventSource, JSON.parse(evt.body), metrics);
        evtDelete.push(evt);
        metrics.scaleUpSuccess();
      } catch (e) {
        if (e instanceof RetryableScalingError) {
          console.error(`Retryable error thrown: "${e.message}"`);
          evtFailed.push([evt, true]);
          evtDelete.push(evt);
        } else {
          console.error(`Non-retryable error during request: "${e.message}"`);
          console.error(`All remaning '${event.Records.length - i}' messages will be scheduled to retry`);
          for (let ii = i; ii < event.Records.length; ii += 1) {
            evtFailed.push([event.Records[ii], false]);
            evtVisible.push(event.Records[ii]);
          }
          break recordsIterProcess;
        }
      }
    }

    if (evtFailed.length > 0) {
      await sendRetryEvents(evtFailed, metrics);
    }

    success = evtFailed.every((i) => {
      return i[1];
    });
  } catch (e) {
    console.error(e);
  } finally {
    try {
      clearTimeout(sndMetricsTimout.setTimeout);
      sndMetricsTimout.metrics = undefined;
      sndMetricsTimout.setTimeout = undefined;
      metrics.sendMetrics();
    } catch (e) {
      console.error(`Error sending metrics: ${e}`);
    }

    if (success) {
      // In this case the framework properly do all the expected cleanup of messages, avoiding jamming
      callback(null);
    } else {
      // In this case the framework does nothing and exits in a dirty state, this makes the message currently being
      // processed to stay in-flight and jam the processing of the other messages due the FIFO nature of the SQS queue
      // so a manual cleanup is required
      const sqs: SQS = new SQS();

      if (evtVisible.length > 0) {
        const queueUrl = getQueueUrl(evtVisible[0], sqs);
        const parameters = {
          Entries: evtVisible.map((evt) => {
            return {
              Id: evt.messageId,
              ReceiptHandle: evt.receiptHandle,
              VisibilityTimeout: 0,
            };
          }),
          QueueUrl: queueUrl,
        };

        try {
          await sqs.changeMessageVisibilityBatch(parameters).promise();
        } catch (e) {
          console.error(`FAILED TO SET MESSAGES BACK TO VISIBLE: ${e}`);
        }
      }

      if (evtDelete.length > 0) {
        const queueUrl = getQueueUrl(evtDelete[0], sqs);
        const parameters = {
          Entries: evtDelete.map((evt) => {
            return {
              Id: evt.messageId,
              ReceiptHandle: evt.receiptHandle,
            };
          }),
          QueueUrl: queueUrl,
        };

        try {
          await sqs.deleteMessageBatch(parameters).promise();
        } catch (e) {
          console.error(`FAILED TO DELETE PROCESSED MESSAGES: ${e}`);
        }
      }

      callback('Failed handling SQS event');
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scaleDown(event: ScheduledEvent, context: Context, callback: any) {
  try {
    await scaleDownR();
    return callback(null);
  } catch (e) {
    console.error(e);
    return callback('Failed');
  }
}
